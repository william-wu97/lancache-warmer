/**
 * Steam prefill orchestration.
 *
 * Chains the existing metadata and download helpers into one app prefill:
 * resolve appinfo, select depots, collect every depot's chunk list, then
 * download the chunks through the fixed-concurrency pool while rotating across
 * CDN hosts. No protocol logic is implemented here and nothing is written to
 * disk: `downloadChunk` reads and discards each response body, exactly as
 * during a real prefill.
 *
 * Tests inject a fake `user` and `opts.downloadChunk`, so they never talk to
 * Steam or open a socket. `opts.parseManifest` is forwarded to `collectChunks`
 * for the same reason.
 */

import { downloadChunk, runPool } from './download.js';
import { collectChunks, collectDepots } from './manifest.js';

/**
 * 并发下载数。从 CONCURRENCY 环境变量读——之前写死 16，compose 里配了
 * CONCURRENCY 也不生效。默认 32：实测单连接速率不高，靠并发堆吞吐。
 */
function defaultConcurrency() {
  const raw = Number(process.env.CONCURRENCY);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 32;
}
const DEFAULT_OS_FILTER = 'windows';

// One chunk gets three attempts, each on the next host in rotation.
const MAX_CHUNK_ATTEMPTS = 3;

/**
 * Cumulative download counters passed to `onProgress`.
 *
 * @typedef {Object} PrefillProgress
 * @property {number} chunksOk Chunks that downloaded successfully.
 * @property {number} chunksFailed Chunks that exhausted all attempts.
 * @property {number} bytes Total body bytes received for successful chunks.
 * @property {number} hit Successful downloads whose response reported a cache
 *   HIT.
 * @property {number} miss Successful downloads whose response reported a cache
 *   MISS.
 */

/**
 * @typedef {Object} PrefillResult
 * @property {number} appId
 * @property {number} depots Number of selected depots.
 * @property {number} chunks Number of chunk downloads planned (per depot;
 *   `collectChunks` already deduplicates within a depot).
 * @property {number} bytes Total body bytes received for successful chunks.
 * @property {number} hit Successful downloads reported as cache HIT.
 * @property {number} miss Successful downloads reported as cache MISS.
 * @property {number} failed Chunks that still failed after every retry. A
 *   failed chunk never aborts the rest of the prefill.
 */

/**
 * @typedef {Object} PrefillOptions
 * @property {string[]} [hosts] Content hosts, normally the output of
 *   `pickHosts`. Required as soon as there is a chunk to download.
 * @property {number} [concurrency] Concurrent chunk downloads. Defaults to 16.
 * @property {string} [osFilter] Platform whose depots are prefilled. Defaults
 *   to `windows`.
 * @property {(progress: PrefillProgress) => void} [onProgress] Called after
 *   every chunk settles, with cumulative counters. A throwing callback is
 *   ignored so progress reporting cannot abort or retry a download.
 * @property {() => boolean} [shouldStop] Checked before each chunk dispatch.
 *   Once it returns true no further chunks start; running chunks finish.
 * @property {(host: string, depotId: number, sha: string, size: number) => Promise<{ bytes?: number, cacheStatus?: string | null }>} [downloadChunk]
 *   Chunk downloader. Defaults to the real `download.js` function; tests
 *   inject a fake.
 * @property {(manifest: Buffer) => object} [parseManifest] Manifest parser,
 *   forwarded to `collectChunks`.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fetch one app's `appinfo` through `steam-user`.
 *
 * A missing app or a product-info response without `appinfo` resolves to
 * `null`; the caller turns that into the "no usable depots" error. A failed
 * request rejects with an error that names the app and keeps the cause.
 *
 * @param {{ getProductInfo: (appIds: number[], packageIds: number[]) => Promise<unknown> }} user
 * @param {number} appId
 * @returns {Promise<object | null>}
 */
async function fetchAppInfo(user, appId) {
  let productInfo;
  try {
    productInfo = await user.getProductInfo([appId], []);
  } catch (error) {
    throw new Error(`Failed to fetch appinfo for app ${appId}: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  const apps = isObject(productInfo) ? productInfo.apps : undefined;
  const app = isObject(apps) ? apps[appId] : undefined;
  const appInfo = isObject(app) ? app.appinfo : undefined;

  return isObject(appInfo) ? appInfo : null;
}

/**
 * Validate and normalize the content hosts. Entries are trimmed; blank entries
 * and non-strings are rejected because they would produce unusable chunk URLs.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeHosts(value) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new TypeError('opts.hosts must be an array of host names');
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new TypeError(`opts.hosts[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
}

/**
 * Prefill one app: resolve its depots, collect their chunks and download every
 * chunk, rotating through `opts.hosts`.
 *
 * A chunk is tried at most three times; each attempt uses the next host in the
 * rotation. A chunk that still fails is counted in `failed` and the pool moves
 * on, so one bad chunk never aborts the app. When no depot is usable (unknown
 * app, no public manifest, or no depot matching `osFilter`) the call rejects
 * with an error naming the app id.
 *
 * @param {{ getProductInfo: Function, getRawManifest: Function }} user
 *   Authenticated `steam-user` instance, or a fake in tests.
 * @param {number} appId
 * @param {PrefillOptions} [opts]
 * @returns {Promise<PrefillResult>}
 */
export async function prefillApp(user, appId, opts = {}) {
  if (!Number.isSafeInteger(appId) || appId <= 0) {
    throw new TypeError(`appId must be a positive safe integer, got ${String(appId)}`);
  }
  if (!isObject(user) || typeof user.getProductInfo !== 'function') {
    throw new TypeError('user must provide getProductInfo()');
  }

  const options = opts ?? {};
  const osFilter = String(options.osFilter ?? DEFAULT_OS_FILTER);
  const concurrency = options.concurrency ?? defaultConcurrency();

  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError('opts.concurrency must be a positive integer');
  }

  if (options.shouldStop !== undefined && options.shouldStop !== null
    && typeof options.shouldStop !== 'function') {
    throw new TypeError('opts.shouldStop must be a function');
  }

  if (options.onProgress !== undefined && options.onProgress !== null
    && typeof options.onProgress !== 'function') {
    throw new TypeError('opts.onProgress must be a function');
  }

  const download = options.downloadChunk ?? downloadChunk;
  if (typeof download !== 'function') {
    throw new TypeError('opts.downloadChunk must be a function');
  }

  const appInfo = await fetchAppInfo(user, appId);
  const depots = collectDepots(appInfo, { osFilter });
  if (depots.length === 0) {
    throw new Error(`No downloadable depots for app ${appId} (osFilter: ${osFilter})`);
  }

  const chunkOptions = options.parseManifest === undefined
    ? {}
    : { parseManifest: options.parseManifest };

  /** @type {{ depotId: number, sha: string, size: number }[]} */
  const tasks = [];
  for (const depot of depots) {
    const chunks = await collectChunks(user, appId, depot, chunkOptions);
    for (const chunk of chunks) {
      tasks.push({ depotId: depot.depotId, sha: chunk.sha, size: chunk.size });
    }
  }

  const hosts = normalizeHosts(options.hosts);
  if (tasks.length > 0 && hosts.length === 0) {
    throw new TypeError('opts.hosts must contain at least one host when there are chunks to download');
  }

  let hostCursor = 0;
  /** @returns {string} */
  function nextHost() {
    const host = hosts[hostCursor % hosts.length];
    hostCursor += 1;
    return host;
  }

  const onProgress = options.onProgress;
  let chunksOk = 0;
  let chunksFailed = 0;
  let bytes = 0;
  let hit = 0;
  let miss = 0;

  function emitProgress() {
    if (typeof onProgress !== 'function') {
      return;
    }

    try {
      onProgress({ chunksOk, chunksFailed, bytes, hit, miss });
    } catch {
      // Progress reporting is advisory; it must not abort or retry downloads.
    }
  }

  // 国内 CDN 要求 auth_key。token 按 (depot, host) 签发并在 steam-user
  // 内部缓存，这里再缓存一层避免每个 chunk 都走一次异步调用。
  const tokenCache = new Map();
  async function authTokenFor(depotId, host) {
    if (typeof user.getCDNAuthToken !== 'function') {
      return '';
    }
    const key = `${depotId}_${host}`;
    if (tokenCache.has(key)) {
      return tokenCache.get(key);
    }
    let token = '';
    try {
      const response = await user.getCDNAuthToken(appId, depotId, host);
      token = typeof response?.token === 'string' ? response.token : '';
    } catch {
      // 拿不到就不带：steamcontent 域名不需要，国内域名会失败并重试
    }
    tokenCache.set(key, token);
    return token;
  }

  /**
   * Download one chunk, retrying on the next host after a failure.
   *
   * @param {{ depotId: number, sha: string, size: number }} task
   * @returns {Promise<void>}
   */
  async function downloadChunkWithRetry(task) {
    for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS; attempt += 1) {
      const host = nextHost();

      try {
        const authToken = await authTokenFor(task.depotId, host);
        const result = await download(host, task.depotId, task.sha, task.size, { authToken });

        chunksOk += 1;
        if (isObject(result) && typeof result.bytes === 'number' && Number.isFinite(result.bytes)) {
          bytes += result.bytes;
        }

        const cacheStatus = isObject(result) && typeof result.cacheStatus === 'string'
          ? result.cacheStatus.toUpperCase()
          : null;
        if (cacheStatus === 'HIT') {
          hit += 1;
        } else if (cacheStatus === 'MISS') {
          miss += 1;
        }

        emitProgress();
        return;
      } catch {
        // Try the next host; after the last attempt the chunk counts as failed.
      }
    }

    chunksFailed += 1;
    emitProgress();
  }

  await runPool(tasks, downloadChunkWithRetry, concurrency, {
    shouldStop: options.shouldStop,
  });

  return {
    appId,
    depots: depots.length,
    // 供上层记录「已缓存 depot」：SteamPrefill 的清单只反映它自己下过的，
    // warmer 自己下的必须单独记账，否则界面上永远看不到新增的 depot。
    depotList: depots.map((depot) => ({
      depotId: depot.depotId,
      manifestId: depot.manifestId,
    })),
    chunks: tasks.length,
    bytes,
    hit,
    miss,
    failed: chunksFailed,
  };
}
