/**
 * Prefill task runner.
 *
 * Owns everything about one background prefill task that does not depend on
 * HTTP: the state machine, the progress snapshot, a ring buffer of recent log
 * lines, and the fan-out to log subscribers (the SSE endpoint). `server.js`
 * only validates the request and maps the results onto status codes.
 *
 * One task may run at a time. `start()` validates the app ids and the stored
 * Steam token, then launches the work without waiting for it, so the HTTP
 * request returns immediately. The task itself connects to Steam, resolves the
 * content hosts and calls `prefillApp` for every requested app. The existing
 * `shouldStop` callback is the only cancellation mechanism: running chunks are
 * allowed to finish and no process is killed.
 *
 * Every external effect is injectable, so tests run the state machine with a
 * fake `prefillApp` and never talk to Steam, disk or the network.
 */

import { randomUUID } from 'node:crypto';

import { connect } from '../providers/steam/client.js';
import { pickHosts } from '../providers/steam/download.js';
import { prefillApp as runPrefillApp } from '../providers/steam/prefill.js';
import { loadToken } from '../providers/steam/token-store.js';

/** Number of most recent log entries kept for replay to new subscribers. */
export const LOG_BUFFER_LIMIT = 500;

const LOG_LEVELS = new Set(['info', 'warn', 'error']);

/**
 * @typedef {'idle' | 'running' | 'done' | 'failed' | 'cancelled'} TaskState
 */

/**
 * Cumulative progress for the current task. `appsDone` counts completed apps;
 * the remaining fields aggregate every chunk of every finished app plus the
 * chunks of the app currently being prefilled.
 *
 * @typedef {Object} TaskProgress
 * @property {number} appsDone
 * @property {number} appsTotal
 * @property {number} chunksOk
 * @property {number} chunksFailed
 * @property {number} bytes
 * @property {number} hit
 * @property {number} miss
 */

/**
 * Task snapshot returned by `GET /api/task`.
 *
 * @typedef {Object} TaskSnapshot
 * @property {TaskState} state
 * @property {number[]} appIds
 * @property {TaskProgress} progress
 * @property {string | null} startedAt ISO timestamp, or null before the first task.
 * @property {string | null} finishedAt ISO timestamp, or null while running.
 * @property {string | null} error Error message when the task failed.
 */

/**
 * One log line. `at` is an ISO timestamp; listeners receive the same immutable
 * objects that are stored in the buffer.
 *
 * @typedef {Object} TaskLogEntry
 * @property {string} at
 * @property {'info' | 'warn' | 'error'} level
 * @property {string} message
 */

/**
 * @typedef {Object} CreateTaskRunnerOptions
 * @property {(user: any, appId: number, opts: object) => Promise<object>} [prefillApp]
 *   Prefill implementation. Defaults to the real `prefillApp`; tests inject a
 *   fake.
 * @property {() => Promise<{ refreshToken: string } | null>} [loadToken]
 *   Reads the stored Steam token. Defaults to `token-store.loadToken`.
 * @property {(opts: { refreshToken: string }) => Promise<any>} [connect]
 *   Establishes the Steam connection. Defaults to `client.connect`.
 * @property {(user: any, appId: number) => Promise<string[]>} [getHosts]
 *   Resolves the content hosts for one app. Defaults to asking the Steam user
 *   for its content servers and filtering with `pickHosts`.
 * @property {() => number} [now] Clock returning Unix time in milliseconds.
 *   Defaults to `Date.now`; tests inject a fake clock.
 */

/** The app ids are missing or not a non-empty array of positive integers. */
export class TaskValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaskValidationError';
  }
}

/** Another prefill task is already running. */
export class TaskConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaskConflictError';
  }
}

/** No Steam token is stored, so the user has to log in first. */
export class NotLoggedInError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotLoggedInError';
  }
}

/**
 * Validate the request payload and return a copy of the app ids.
 *
 * @param {unknown} value
 * @returns {number[]}
 */
export function normalizeAppIds(value) {
  if (!Array.isArray(value)) {
    throw new TaskValidationError('appIds 必须是数组');
  }

  if (value.length === 0) {
    throw new TaskValidationError('appIds 不能为空');
  }

  return value.map((entry, index) => {
    if (!Number.isSafeInteger(entry) || entry <= 0) {
      throw new TaskValidationError(`appIds[${index}] 必须是正整数`);
    }
    return entry;
  });
}

/**
 * @param {number} appsTotal
 * @returns {TaskProgress}
 */
function emptyProgress(appsTotal) {
  return Object.freeze({
    appsDone: 0,
    appsTotal,
    chunksOk: 0,
    chunksFailed: 0,
    bytes: 0,
    hit: 0,
    miss: 0,
  });
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * @param {unknown} error
 * @param {string} [secret] Value to redact from the message.
 * @returns {string}
 */
function errorMessageOf(error, secret = '') {
  const message = error instanceof Error ? error.message : String(error);
  return secret === '' ? message : message.split(secret).join('[redacted]');
}

/**
 * Structural check for a Steam refresh token. `steam-user` decodes the JWT
 * inside a `process.nextTick` callback; a malformed value throws there as an
 * unhandled rejection and takes the process down, so it is rejected before the
 * connection is attempted. The checks mirror steam-user's own: three JWT
 * segments, issuer `steam`, client audience and a numeric subject.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isUsableRefreshToken(value) {
  if (typeof value !== 'string' || value === '') {
    return false;
  }

  const parts = value.split('.');
  if (parts.length !== 3) {
    return false;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return false;
  }

  if (payload === null || typeof payload !== 'object') {
    return false;
  }

  const audience = payload.aud;
  const hasClientAudience = Array.isArray(audience)
    ? audience.includes('client')
    : audience === 'client';

  return payload.iss === 'steam'
    && hasClientAudience
    && typeof payload.sub === 'string'
    && /^\d+$/.test(payload.sub);
}

/**
 * `steam-user` reports content servers as objects with a capitalised `Host`
 * field, while `pickHosts` also accepts plain strings and lower-case keys.
 * Reduce the objects to their host name first.
 *
 * @param {unknown} servers
 * @returns {unknown}
 */
function contentServerEntries(servers) {
  if (!Array.isArray(servers)) {
    return servers;
  }

  return servers.map((server) => {
    if (server === null || typeof server !== 'object') {
      return server;
    }

    const record = /** @type {Record<string, unknown>} */ (server);
    return record.Host ?? record.host ?? record.hostname ?? record.domain ?? server;
  });
}

/**
 * Default content-host resolver: ask `steam-user` for the servers usable by
 * this app, then keep only Steam content cache nodes.
 *
 * @param {any} user
 * @param {number} appId
 * @returns {Promise<string[]>}
 */
async function defaultGetHosts(user, appId) {
  // 先用公开的内容目录接口：steam-user 的 getContentServers 只返回本 cell
  // 的节点，实测全是 cacheN-tyo3（东京），单连接 27KB/s 还频繁超时。
  // 这个接口不受登录态影响，返回的是国内 CDN（clngaa / pphimalayanrt 等），
  // 而这些域名同样能命中 lancache（见 access.log 的 HIT 记录）。
  // 国内节点（clngaa 等）确实能命中 lancache，但要求 URL 带 auth_key，
  // 而 warmer 构造的 chunk URL 不带（steamcontent 域名靠 lancache 兜住了）。
  // 所以默认仍走 getContentServers；设 STEAM_PUBLIC_CDN=1 才用国内节点。
  if (process.env.STEAM_PUBLIC_CDN === '1') {
    const publicHosts = await fetchPublicHosts();
    if (publicHosts.length > 0) {
      return publicHosts;
    }
  }

  if (user === null || typeof user !== 'object' || typeof user.getContentServers !== 'function') {
    throw new TypeError('Steam 客户端不支持 getContentServers()');
  }

  const response = await user.getContentServers(appId);
  const servers = Array.isArray(response) ? response : response?.servers;
  return pickHosts(contentServerEntries(servers));
}

/**
 * Steam 的公开 CDN 目录。cell_id=0 表示不限区域，返回的是按当前出口 IP
 * 优选的节点集合——在国内网络下通常就是那三个国内域名。
 *
 * @returns {Promise<string[]>}
 */
async function fetchPublicHosts() {
  const url = 'https://api.steampowered.com/IContentServerDirectoryService/GetServersForSteamPipe/v1/?cell_id=0&max_servers=20';
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      return [];
    }
    const payload = await response.json();
    const servers = payload?.response?.servers;
    if (!Array.isArray(servers)) {
      return [];
    }
    const hosts = [];
    const seen = new Set();
    for (const server of servers) {
      const host = typeof server?.host === 'string' ? server.host.trim().toLowerCase() : '';
      if (host !== '' && !seen.has(host)) {
        seen.add(host);
        hosts.push(host);
      }
    }
    return hosts;
  } catch {
    return [];
  }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {asserts value is Function}
 */
function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
}

/**
 * Create a task runner. Each instance owns its own state, so several servers
 * (for example one per test) never share a task or log buffer.
 *
 * @param {CreateTaskRunnerOptions} [options]
 * @returns {{
 *   start: (appIds: unknown) => Promise<{ taskId: string, state: 'running' }>,
 *   getSnapshot: () => TaskSnapshot,
 *   getLogs: () => TaskLogEntry[],
 *   subscribe: (listener: (entry: TaskLogEntry) => void) => () => void,
 *   cancel: () => boolean,
 *   whenSettled: () => Promise<TaskSnapshot>,
 *   log: (level: 'info' | 'warn' | 'error', message: string) => TaskLogEntry,
 * }}
 */
export function createTaskRunner(options = {}) {
  const opts = options ?? {};
  const {
    prefillApp = runPrefillApp,
    loadToken: loadTokenFn = loadToken,
    connect: connectFn = connect,
    getHosts = defaultGetHosts,
    now = Date.now,
  } = opts;

  assertFunction(prefillApp, 'options.prefillApp');
  assertFunction(loadTokenFn, 'options.loadToken');
  assertFunction(connectFn, 'options.connect');
  assertFunction(getHosts, 'options.getHosts');
  assertFunction(now, 'options.now');

  /** @type {TaskLogEntry[]} */
  const logs = [];
  /** @type {Set<(entry: TaskLogEntry) => void>} */
  const listeners = new Set();

  /** @type {TaskState} */
  let state = 'idle';
  /** @type {number[]} */
  let currentAppIds = [];
  /** @type {TaskProgress} */
  let progress = emptyProgress(0);
  /** @type {string | null} */
  let startedAt = null;
  /** @type {string | null} */
  let finishedAt = null;
  /** @type {string | null} */
  let errorMessage = null;
  let cancelRequested = false;
  let starting = false;
  /** @type {((snapshot: TaskSnapshot) => void)[]} */
  let settleWaiters = [];

  /** @returns {string} */
  function timestamp() {
    return new Date(Number(now())).toISOString();
  }

  /**
   * Append one log line, trim the ring buffer and notify subscribers. A broken
   * subscriber must never take the task down, so listener errors are ignored.
   *
   * @param {'info' | 'warn' | 'error'} level
   * @param {string} message
   * @returns {TaskLogEntry}
   */
  function log(level, message) {
    if (!LOG_LEVELS.has(level)) {
      throw new TypeError(`log level must be one of ${[...LOG_LEVELS].join(', ')}`);
    }
    if (typeof message !== 'string' || message.trim() === '') {
      throw new TypeError('log message must be a non-empty string');
    }

    const entry = Object.freeze({ at: timestamp(), level, message });
    logs.push(entry);
    if (logs.length > LOG_BUFFER_LIMIT) {
      logs.splice(0, logs.length - LOG_BUFFER_LIMIT);
    }

    for (const listener of [...listeners]) {
      try {
        listener(entry);
      } catch {
        // Subscribers are advisory; a dead SSE connection cannot fail the task.
      }
    }

    return entry;
  }

  /** @returns {TaskSnapshot} */
  function getSnapshot() {
    return {
      state,
      appIds: currentAppIds.slice(),
      progress: { ...progress },
      startedAt,
      finishedAt,
      error: errorMessage,
    };
  }

  /** @returns {TaskLogEntry[]} */
  function getLogs() {
    return logs.slice();
  }

  /**
   * Subscribe to log lines. The buffered history is replayed synchronously
   * before the listener is registered, so a new SSE connection gets the recent
   * lines followed by every later line without a gap.
   *
   * @param {(entry: TaskLogEntry) => void} listener
   * @returns {() => void} Unsubscribe function; safe to call repeatedly.
   */
  function subscribe(listener) {
    assertFunction(listener, 'listener');

    for (const entry of logs) {
      try {
        listener(entry);
      } catch {
        // Keep replaying the rest of the buffer for this subscriber.
      }
    }

    listeners.add(listener);
    let active = true;

    return () => {
      if (!active) {
        return;
      }
      active = false;
      listeners.delete(listener);
    };
  }

  /**
   * Resolve once no task is running. Resolves immediately with the current
   * snapshot when the runner is idle or the last task already settled.
   *
   * @returns {Promise<TaskSnapshot>}
   */
  function whenSettled() {
    if (state !== 'running') {
      return Promise.resolve(getSnapshot());
    }

    return new Promise((resolve) => {
      settleWaiters.push(resolve);
    });
  }

  /**
   * Ask the running task to stop. The existing `shouldStop` callback is polled
   * by `prefillApp`; chunks already downloading finish normally. The task moves
   * to `cancelled` once it settles.
   *
   * @returns {boolean} Whether a running task was asked to stop.
   */
  function cancel() {
    if (state !== 'running') {
      return false;
    }

    if (!cancelRequested) {
      cancelRequested = true;
      log('warn', '收到取消请求，正在停止任务…');
    }

    return true;
  }

  /**
   * Move to a terminal state, record the finish time, log the outcome and
   * release every `whenSettled` waiter.
   *
   * @param {'done' | 'failed' | 'cancelled'} finalState
   * @param {string} [message]
   */
  function settle(finalState, message) {
    if (state !== 'running') {
      return;
    }

    state = finalState;
    finishedAt = timestamp();

    if (finalState === 'failed') {
      errorMessage = message === undefined || message === '' ? '未知错误' : message;
      log('error', `任务失败：${errorMessage}`);
    } else if (finalState === 'cancelled') {
      log('info', '任务已取消');
    } else {
      log('info', '任务完成');
    }

    const snapshot = getSnapshot();
    const waiters = settleWaiters;
    settleWaiters = [];
    for (const resolve of waiters) {
      resolve(snapshot);
    }
  }

  /**
   * Execute the task in the background. Every failure is recorded in the
   * snapshot, so this promise never rejects.
   *
   * @param {{ refreshToken: string }} token
   * @returns {Promise<void>}
   */
  async function runTask(token) {
    const appsTotal = currentAppIds.length;
    const base = {
      chunksOk: 0,
      chunksFailed: 0,
      bytes: 0,
      hit: 0,
      miss: 0,
    };
    let appsDone = 0;

    /**
     * Publish cumulative progress for the app currently being prefilled.
     *
     * @param {unknown} update
     */
    const publishProgress = (update) => {
      const value = update ?? {};
      progress = Object.freeze({
        appsDone,
        appsTotal,
        chunksOk: base.chunksOk + numberOrZero(value.chunksOk),
        chunksFailed: base.chunksFailed + numberOrZero(value.chunksFailed),
        bytes: base.bytes + numberOrZero(value.bytes),
        hit: base.hit + numberOrZero(value.hit),
        miss: base.miss + numberOrZero(value.miss),
      });
    };

    try {
      log('info', `开始预填充：应用 ${currentAppIds.join(', ')}`);
      log('info', '正在连接 Steam…');
      const user = await connectFn({ refreshToken: token.refreshToken });

      for (const appId of currentAppIds) {
        if (cancelRequested) {
          break;
        }

        log('info', `开始应用 ${appId}`);
        const hosts = await getHosts(user, appId);
        if (!Array.isArray(hosts) || hosts.length === 0) {
          throw new Error(`Steam 没有为应用 ${appId} 返回可用的内容节点`);
        }
        // 节点列表直接决定下载速度：全是东京节点时慢得离谱，打出来便于确认
        log('info', `内容节点 ${hosts.length} 个：${hosts.slice(0, 12).join(' / ')}`);

        const result = await prefillApp(user, appId, {
          hosts,
          shouldStop: () => cancelRequested,
          onProgress: publishProgress,
        });

        const chunks = numberOrZero(result?.chunks);
        const failed = numberOrZero(result?.failed);
        const hit = numberOrZero(result?.hit);
        const miss = numberOrZero(result?.miss);
        const bytes = numberOrZero(result?.bytes);

        base.chunksOk += Math.max(0, chunks - failed);
        base.chunksFailed += failed;
        base.bytes += bytes;
        base.hit += hit;
        base.miss += miss;
        appsDone += 1;
        progress = Object.freeze({ appsDone, appsTotal, ...base });

        log(
          failed > 0 ? 'warn' : 'info',
          `应用 ${appId} 完成：${chunks - failed}/${chunks} 个 chunk 成功，`
            + `${hit} HIT / ${miss} MISS，${bytes} 字节`,
        );
      }

      settle(cancelRequested ? 'cancelled' : 'done');
    } catch (error) {
      settle('failed', errorMessageOf(error, token.refreshToken));
    }
  }

  /**
   * Validate the request, check the stored login and launch one background
   * task. Only one task may run at a time; a second call is rejected with
   * `TaskConflictError` even while the first one is still reading its token.
   *
   * @param {unknown} requestedAppIds
   * @returns {Promise<{ taskId: string, state: 'running' }>}
   */
  async function start(requestedAppIds) {
    const ids = normalizeAppIds(requestedAppIds);

    if (starting || state === 'running') {
      throw new TaskConflictError('已有预填充任务在运行');
    }

    starting = true;
    try {
      const token = await loadTokenFn();
      if (
        token === null
        || typeof token !== 'object'
        || !isUsableRefreshToken(token.refreshToken)
      ) {
        throw new NotLoggedInError('未登录 Steam，请先扫码登录');
      }

      state = 'running';
      const taskId = randomUUID();
      currentAppIds = ids;
      progress = emptyProgress(ids.length);
      startedAt = timestamp();
      finishedAt = null;
      errorMessage = null;
      cancelRequested = false;

      // `runTask` records its own failures; this catch only guards against a
      // programming error escaping it and becoming an unhandled rejection.
      void runTask(token).catch((error) => {
        settle('failed', errorMessageOf(error, token.refreshToken));
      });

      return { taskId, state: 'running' };
    } finally {
      starting = false;
    }
  }

  return Object.freeze({
    start,
    getSnapshot,
    getLogs,
    subscribe,
    cancel,
    whenSettled,
    log,
  });
}
