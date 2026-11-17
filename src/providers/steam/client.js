/**
 * Steam connection lifecycle.
 *
 * A single `steam-user` instance is kept in this module so the upper layers
 * (depot queries, manifest fetches) can share one authenticated CM connection.
 * `connect()` logs on with a refresh token and resolves once Steam reports
 * `loggedOn`; `disconnect()` logs the instance off and clears it; `getUser()`
 * exposes the current instance (or `null`).
 *
 * The refresh token is only passed to `logOn` for the lifetime of the call. It
 * is never written to disk or included in logs or error messages, and the
 * post-login `error` handler redacts it as a safety net.
 *
 * Tests must never talk to Steam: the constructor is injectable through
 * `opts.steamUserFactory` (defaulting to `new SteamUser(options)`), and tests
 * supply a fake whose events they emit locally. A fake only needs `logOn`,
 * `logOff` and `on`; `removeListener` is used when present.
 */

import SteamUser from 'steam-user';

const DEFAULT_TIMEOUT_MS = 60_000;

/** Steam cell id used for CM discovery; 35 works reliably from CN networks. */
const DEFAULT_CELL_ID = 35;

/**
 * @typedef {Object} SteamUserLike
 * @property {(details: { refreshToken: string }) => void} logOn Starts the
 *   login.
 * @property {() => void} [logOff] Ends the session when supported.
 * @property {(event: string, listener: (...args: any[]) => void) => void} on
 *   Event subscription (`loggedOn`, `error`).
 * @property {(event: string, listener: (...args: any[]) => void) => void} [removeListener]
 */

/**
 * @typedef {(options: { autoRelogin: boolean }) => SteamUserLike} SteamUserFactory
 */

/**
 * @typedef {Object} ConnectOptions
 * @property {string} refreshToken Steam refresh token. Required; never logged.
 * @property {number} [timeoutMs] How long to wait for `loggedOn`. Defaults to
 *   30 seconds.
 * @property {SteamUserFactory} [steamUserFactory] Constructor used to create
 *   the instance. Defaults to `new SteamUser(options)`; tests inject a fake.
 * @property {{ error: (...args: any[]) => void }} [logger] Sink for
 *   post-login connection errors. Defaults to `console`; tests inject a spy.
 */

/**
 * @typedef {Object} PendingLogin
 * @property {string} token Token used for this attempt, for reuse detection.
 * @property {SteamUserLike} instance Instance being logged on.
 * @property {Promise<SteamUserLike>} promise Shared by concurrent callers
 *   using the same token.
 * @property {(value: SteamUserLike) => void} resolve
 * @property {(reason: Error) => void} reject
 * @property {ReturnType<typeof setTimeout>} timer
 * @property {() => void} onLoggedOn
 * @property {(error: unknown) => void} onError
 */

/** @type {SteamUserLike | null} */
let user = null;

/** Token of the established connection; used to detect a token change. */
let token = null;

/** @type {PendingLogin | null} */
let pending = null;

/**
 * Default constructor. Kept behind `opts.steamUserFactory` so tests never need
 * `steam-user` to open a connection.
 *
 * @param {{ autoRelogin: boolean }} options
 * @returns {SteamUserLike}
 */
function defaultSteamUserFactory(options) {
  return new SteamUser(options);
}

/**
 * Call `logOff` when the instance supports it. A failing logoff must not stop
 * the singleton from being cleared.
 *
 * @param {SteamUserLike} instance
 */
function safeLogOff(instance) {
  if (typeof instance.logOff !== 'function') {
    return;
  }

  try {
    instance.logOff();
  } catch {
    // The connection is dropped either way; the caller only needs it gone.
  }
}

/**
 * Remove one of our listeners when the instance exposes `removeListener`.
 * Fakes used in tests may only implement `on`.
 *
 * @param {SteamUserLike} instance
 * @param {string} event
 * @param {(...args: any[]) => void} listener
 */
function removeListener(instance, event, listener) {
  if (typeof instance.removeListener === 'function') {
    instance.removeListener(event, listener);
  }
}

/**
 * @param {unknown} error
 * @returns {Error}
 */
function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return toError(error).message;
}

/**
 * Build the message logged for a post-login connection error. The refresh
 * token is replaced if a library error happens to embed it.
 *
 * @param {unknown} error
 * @param {string} secret
 * @returns {string}
 */
function redactedErrorMessage(error, secret) {
  const message = errorMessage(error);
  return secret === '' ? message : message.split(secret).join('[redacted]');
}

/**
 * Reject a pending login and drop its connection, removing the success
 * listener so a late `loggedOn` cannot revive a cancelled connection. The
 * error listener is intentionally kept attached: after this point steam-user
 * errors are only recorded, never emitted as unhandled `error` events.
 *
 * @param {PendingLogin} entry
 * @param {Error} reason
 */
function cancelPending(entry, reason) {
  if (pending === entry) {
    pending = null;
  }
  clearTimeout(entry.timer);
  removeListener(entry.instance, 'loggedOn', entry.onLoggedOn);
  safeLogOff(entry.instance);
  entry.reject(reason);
}

/**
 * Force a specific Steam cell id on CM discovery requests.
 *
 * Without this, `GetCMListForConnect` returns a global list and, on networks
 * with poor routing to Steam, the client keeps picking unreachable servers
 * until the login times out. Pinning the cell makes Steam reply with CMs for
 * that region only.
 *
 * @param {SteamUserLike & { _apiRequest?: Function }} instance
 * @param {number} cellId
 */
function patchCellId(instance, cellId) {
  const original = instance?._apiRequest;
  if (typeof original !== 'function') {
    // Fake instances used in tests don't implement this; nothing to patch.
    return;
  }

  const bound = original.bind(instance);
  instance._apiRequest = (method, iface, name, version, parameters, ...rest) => {
    let next = parameters;
    if (name === 'GetCMListForConnect') {
      next = { ...parameters, cellid: cellId };
    } else if (name === 'GetServersForSteamPipe') {
      next = { ...parameters, cell_id: cellId };
    }
    return bound(method, iface, name, version, next, ...rest);
  };
}

/**
 * Create and log on a new `steam-user` instance.
 *
 * @param {SteamUserFactory} factory
 * @param {number} timeoutMs
 * @param {string} refreshToken
 * @param {{ error: (...args: any[]) => void }} logger
 * @returns {Promise<SteamUserLike>}
 */
function startLogin(factory, timeoutMs, refreshToken, logger, cellId) {
  let instance;
  try {
    instance = factory({ autoRelogin: true });
  } catch (error) {
    return Promise.reject(toError(error));
  }

  let resolveLogin;
  let rejectLogin;
  const promise = new Promise((resolve, reject) => {
    resolveLogin = resolve;
    rejectLogin = reject;
  });

  /** @type {PendingLogin} */
  const entry = {
    token: refreshToken,
    instance,
    promise,
    resolve: resolveLogin,
    reject: rejectLogin,
    timer: /** @type {ReturnType<typeof setTimeout>} */ (undefined),
    onLoggedOn: () => {},
    onError: () => {},
  };

  entry.onLoggedOn = () => {
    if (pending !== entry) {
      return;
    }

    clearTimeout(entry.timer);
    pending = null;
    user = instance;
    token = refreshToken;
    removeListener(instance, 'loggedOn', entry.onLoggedOn);
    entry.resolve(instance);
  };

  entry.onError = (error) => {
    if (pending === entry) {
      // The first error before loggedOn aborts this attempt; the connection
      // must not linger in an auto-relogin loop.
      cancelPending(entry, toError(error));
      return;
    }

    // Post-login errors are recorded only. Keeping this listener attached also
    // prevents an unhandled `error` event from crashing the process.
    try {
      logger.error('[steam] connection error:', redactedErrorMessage(error, refreshToken));
    } catch {
      // Logging must never take the process down.
    }
  };

  entry.timer = setTimeout(() => {
    if (pending !== entry) {
      return;
    }

    cancelPending(
      entry,
      new Error(`Steam 登录超时：${timeoutMs}ms 内未收到 loggedOn 事件`),
    );
  }, timeoutMs);

  pending = entry;
  instance.on('loggedOn', entry.onLoggedOn);
  instance.on('error', entry.onError);
  // steam-user 的 debug 流会打印 CM 握手细节。登录超时时只有这里有线索：
  // 到底是 DNS、TCP 还是协议层。开关由 STEAM_DEBUG=1 控制，平时保持安静。
  if (process.env.STEAM_DEBUG === '1') {
    instance.on('debug', (message) => {
      try {
        logger.error('[steam-debug]', String(message).slice(0, 300));
      } catch {
        // ignore
      }
    });
  }

  // 国内网络下 steam-user 默认拿到的 CM 列表常含连不上的节点，表现就是
  // 反复超时。实测有效做法是强制指定 cellid，让 Steam 只返回该区域的 CM。
  // 这段是踩坑换来的：没有它，30 秒超时几乎必然发生。
  patchCellId(instance, cellId);

  try {
    instance.logOn({
      refreshToken,
      // 不带 logonID 和 machineName 时，Steam 有时会拖很久才回 loggedOn
      logonID: 30993,
      machineName: 'lancache-warmer',
    });
  } catch (error) {
    if (pending === entry) {
      cancelPending(entry, toError(error));
    }
  }

  return promise;
}

/**
 * Log on to Steam, reusing an existing connection when the token matches.
 *
 * - A missing, empty or non-string `opts.refreshToken` throws a `TypeError`
 *   synchronously.
 * - An established connection with the same token is returned without calling
 *   `logOn` again. Concurrent `connect` calls with the same token share one
 *   in-flight login.
 * - A different token disconnects the current instance (and cancels an
 *   in-flight login) before creating the new one.
 *
 * @param {ConnectOptions} [opts]
 * @returns {Promise<SteamUserLike>}
 */
export function connect(opts = {}) {
  const refreshToken = opts.refreshToken;
  if (typeof refreshToken !== 'string' || refreshToken.trim() === '') {
    throw new TypeError('connect() requires opts.refreshToken to be a non-empty string');
  }

  if (pending !== null) {
    if (pending.token === refreshToken) {
      return pending.promise;
    }

    // A different token supersedes an unfinished login. Its promise rejects so
    // the caller knows this attempt was not established.
    cancelPending(pending, new Error('Steam 登录已被新的连接请求替换'));
  }

  if (user !== null) {
    if (token === refreshToken) {
      return Promise.resolve(user);
    }

    disconnect();
  }

  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const factory = typeof opts.steamUserFactory === 'function'
    ? opts.steamUserFactory
    : defaultSteamUserFactory;
  // 35 是实测在国内容易连通的 cell；没有它 CM 列表会给出连不上的节点。
  const cellId = Number.isFinite(opts.cellId) ? opts.cellId : DEFAULT_CELL_ID;
  const logger = opts.logger !== null && typeof opts.logger === 'object' && typeof opts.logger.error === 'function'
    ? opts.logger
    : console;

  return startLogin(factory, timeoutMs, refreshToken, logger, cellId);
}

/**
 * Drop the current connection. Calls `logOff` when the instance supports it,
 * cancels an in-flight login (rejecting its promise) and clears the singleton.
 * Calling it without a connection is a no-op.
 */
export function disconnect() {
  if (pending !== null) {
    cancelPending(pending, new Error('Steam 连接已断开'));
  }

  if (user !== null) {
    const instance = user;
    user = null;
    token = null;
    safeLogOff(instance);
  }
}

/**
 * The current authenticated instance, or `null` when there is none. A login
 * that has not emitted `loggedOn` yet is not considered connected.
 *
 * @returns {SteamUserLike | null}
 */
export function getUser() {
  return user;
}
