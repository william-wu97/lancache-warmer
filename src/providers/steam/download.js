/**
 * Streaming Steam chunk downloads and a fixed-concurrency task pool.
 *
 * A chunk is pulled from a Steam content host and every received byte is
 * discarded as soon as it arrives. Nothing is buffered, written to disk or
 * returned, so memory use does not grow with the chunk size. The only side
 * effect is the traffic itself, which is exactly what warms lancache.
 *
 * Tests must never reach the network: `opts.fetcher` defaults to the global
 * `fetch` but can be replaced with a fake returning a `Response`.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const USER_AGENT = 'Valve/Steam HTTP Client 1.0';

// Public Steam content nodes (for example cloudflare.steamstatic.com) are mixed
// into the CDN list and answer 403 to some client IPs. Only the cache nodes
// below this domain are usable, so every other host is dropped.
const CONTENT_DOMAIN = 'steamcontent.com';

/**
 * @typedef {Object} DownloadResult
 * @property {number} bytes Number of body bytes actually received.
 * @property {'HIT' | 'MISS' | null} cacheStatus `x-cache-status` of the
 *   response, or `null` when the header is absent or not a cache verdict.
 */

/**
 * @typedef {Object} DownloadOptions
 * @property {typeof fetch} [fetcher] HTTP implementation. Defaults to the
 *   global `fetch`; tests inject a fake so they never open a socket.
 * @property {number} [timeoutMs] Deadline for the whole request, including
 *   reading the body. Defaults to 30 seconds.
 */

/**
 * @typedef {Object} PoolOptions
 * @property {() => boolean} [shouldStop] Checked before each dispatch. Once it
 *   returns true no further items are started; already-running workers finish
 *   normally.
 */

/**
 * @typedef {Object} PoolResult
 * @property {number} total Number of items in the pool.
 * @property {number} started Number of items a worker was started for.
 * @property {number} succeeded Number of workers that resolved.
 * @property {number} failed Number of workers that rejected.
 * @property {boolean} stopped Whether `shouldStop` prevented some items from
 *   being dispatched.
 */

/**
 * @typedef {Object} PickHostsOptions
 * @property {string} [suffix] Domain suffix to keep. Defaults to
 *   `steamcontent.com`.
 */

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {asserts value is string}
 */
function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

/**
 * Byte length of one stream chunk without copying it.
 *
 * `fetch` bodies yield `Uint8Array` chunks, but a fake or a wrapper might yield
 * strings, so both forms are measured.
 *
 * @param {unknown} chunk
 * @returns {number}
 */
function chunkByteLength(chunk) {
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk);
  }

  if (chunk !== null && typeof chunk === 'object') {
    if (typeof (/** @type {{ byteLength?: unknown }} */ (chunk)).byteLength === 'number') {
      return /** @type {{ byteLength: number }} */ (chunk).byteLength;
    }
    if (typeof (/** @type {{ length?: unknown }} */ (chunk)).length === 'number') {
      return /** @type {{ length: number }} */ (chunk).length;
    }
  }

  throw new TypeError('chunk stream yielded a value without a byte length');
}

/**
 * Read `x-cache-status` from a `Headers` instance (or a plain object). The
 * value is normalised to upper case; anything that is not HIT/MISS, including
 * an absent header, is reported as `null` instead of failing the download.
 *
 * @param {unknown} headers
 * @returns {'HIT' | 'MISS' | null}
 */
function parseCacheStatus(headers) {
  /** @type {unknown} */
  let raw;

  if (headers !== null && typeof headers === 'object' && typeof headers.get === 'function') {
    raw = headers.get('x-cache-status');
  } else if (headers !== null && typeof headers === 'object') {
    raw = /** @type {Record<string, unknown>} */ (headers)['x-cache-status'];
  }

  if (typeof raw !== 'string') {
    return null;
  }

  const status = raw.trim().toUpperCase();
  return status === 'HIT' || status === 'MISS' ? status : null;
}

/**
 * Best-effort cancellation of an unread body when the response is not usable.
 *
 * @param {unknown} body
 * @returns {Promise<void>}
 */
async function cancelBody(body) {
  if (body !== null && typeof body === 'object' && typeof body.cancel === 'function') {
    try {
      await body.cancel();
    } catch {
      // The connection is being abandoned anyway; cancellation is advisory.
    }
  }
}

/**
 * Download one chunk and discard its content.
 *
 * The response body is consumed with `for await`; only the running byte count
 * is kept, so peak memory does not depend on the chunk size. A body whose size
 * differs from `expectedSize` is rejected, as is a non-2xx response. When
 * `timeoutMs` elapses the request is aborted and the returned promise rejects.
 *
 * @param {string} host Content host, for example
 *   `cache7-tyo3.steamcontent.com`.
 * @param {number | string} depotId Depot id, as used in the chunk path.
 * @param {string} sha Chunk sha, as used in the chunk path.
 * @param {number} expectedSize Compressed chunk size in bytes.
 * @param {DownloadOptions} [opts]
 * @returns {Promise<DownloadResult>}
 */
export async function downloadChunk(host, depotId, sha, expectedSize, opts = {}) {
  assertNonEmptyString(host, 'host');
  assertNonEmptyString(sha, 'sha');

  if (
    (typeof depotId !== 'number' && typeof depotId !== 'string')
    || String(depotId).trim() === ''
  ) {
    throw new TypeError('depotId must be a number or non-empty string');
  }

  if (typeof expectedSize !== 'number' || !Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new TypeError('expectedSize must be a non-negative integer');
  }

  const fetcher = opts.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== 'function') {
    throw new TypeError('opts.fetcher must be a function');
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('opts.timeoutMs must be a positive number');
  }

  const url = `http://${host}/depot/${depotId}/chunk/${sha}`;
  const controller = new AbortController();

  let timeoutId;
  let timeoutError = null;

  /**
   * The whole request/read sequence, raced against a timer so a fetcher that
   * ignores the abort signal still cannot exceed the deadline.
   */
  const request = (async () => {
    const response = await fetcher(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (response === null || typeof response !== 'object') {
      throw new Error(`Chunk ${sha} from ${host} returned no response`);
    }

    if (!response.ok) {
      await cancelBody(response.body);
      throw new Error(
        `Chunk ${sha} from ${host} failed with HTTP ${response.status}`,
      );
    }

    let bytes = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        // Drop the payload immediately; only its length is retained.
        bytes += chunkByteLength(chunk);
      }
    }

    if (bytes !== expectedSize) {
      throw new Error(
        `Chunk ${sha} from ${host} size mismatch: expected ${expectedSize} bytes, got ${bytes}`,
      );
    }

    return { bytes, cacheStatus: parseCacheStatus(response.headers) };
  })();

  const deadline = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timeoutError = new Error(
        `Chunk ${sha} from ${host} timed out after ${timeoutMs}ms`,
      );
      controller.abort();
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([request, deadline]);
  } catch (error) {
    // Prefer the stable timeout message over the AbortError that the abort
    // just produced (or that a fake fetcher never produced at all).
    throw timeoutError ?? error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Run `worker` over `items` with at most `concurrency` tasks in flight.
 *
 * Items are dispatched lazily rather than all at once, so a large chunk list
 * never creates a matching number of pending promises. A rejected worker is
 * counted and the pool continues with the next item; it never rejects because
 * of a single task.
 *
 * @template T
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<unknown>} worker
 * @param {number} concurrency Maximum number of concurrently running workers.
 * @param {PoolOptions} [opts]
 * @returns {Promise<PoolResult>}
 */
export async function runPool(items, worker, concurrency, opts = {}) {
  if (!Array.isArray(items)) {
    throw new TypeError('items must be an array');
  }
  if (typeof worker !== 'function') {
    throw new TypeError('worker must be a function');
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError('concurrency must be a positive integer');
  }
  if (opts.shouldStop !== undefined && opts.shouldStop !== null && typeof opts.shouldStop !== 'function') {
    throw new TypeError('opts.shouldStop must be a function');
  }

  const total = items.length;
  const shouldStop = opts.shouldStop;

  let nextIndex = 0;
  let started = 0;
  let succeeded = 0;
  let failed = 0;

  const stopping = () => typeof shouldStop === 'function' && Boolean(shouldStop());

  /** @returns {Promise<void>} */
  async function runWorker() {
    for (;;) {
      if (stopping()) {
        return;
      }

      const index = nextIndex;
      nextIndex += 1;
      if (index >= total) {
        return;
      }

      started += 1;
      try {
        await worker(items[index], index);
        succeeded += 1;
      } catch {
        // One failed chunk must not abort the rest of the pool.
        failed += 1;
      }
    }
  }

  // Never spawn more workers than there are items to process.
  const workerCount = Math.min(concurrency, total);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return {
    total,
    started,
    succeeded,
    failed,
    stopped: started < total,
  };
}

/**
 * Normalise one host entry to a bare lower-case hostname.
 *
 * Accepts bare hosts (`cache7-tyo3.steamcontent.com`), hosts with a port, and
 * URLs (`http://host/path`). Invalid entries yield `null` and are skipped.
 *
 * @param {string} value
 * @returns {string | null}
 */
function normalizeHost(value) {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }

  let host = trimmed;

  if (host.includes('://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  } else {
    // A plain host may still carry a path or a port.
    host = host.split('/')[0];
    const colon = host.lastIndexOf(':');
    if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) {
      host = host.slice(0, colon);
    }
  }

  host = host.replace(/\.$/, '').toLowerCase();
  return host === '' ? null : host;
}

/**
 * Collect host strings from the shapes a Steam CDN list comes in: an array of
 * host names, an array of server objects carrying `host`/`hostname`, or an
 * object keyed by host name.
 *
 * @param {unknown} servers
 * @returns {string[]}
 */
function hostEntries(servers) {
  if (Array.isArray(servers)) {
    /** @type {string[]} */
    const hosts = [];

    for (const entry of servers) {
      if (typeof entry === 'string') {
        hosts.push(entry);
        continue;
      }

      if (entry !== null && typeof entry === 'object') {
        const record = /** @type {Record<string, unknown>} */ (entry);
        const host = record.host ?? record.hostname ?? record.domain;
        if (typeof host === 'string') {
          hosts.push(host);
        }
      }
    }

    return hosts;
  }

  if (servers !== null && typeof servers === 'object') {
    // steam-user's content-server map uses host names as keys.
    return Object.keys(servers);
  }

  return [];
}

/**
 * Keep only Steam cache nodes from a CDN server list.
 *
 * The list also contains public nodes such as
 * `cloudflare.steamstatic.com`, which return 403 to some client IPs and never
 * touch lancache. Only names equal to or below `steamcontent.com` are kept;
 * unrelated suffixes that merely contain the text (`notsteamcontent.com`) do
 * not match. Results are de-duplicated and lower-cased, preserving order.
 *
 * @param {unknown} servers Server list; see `hostEntries` for accepted shapes.
 * @param {PickHostsOptions} [opts]
 * @returns {string[]}
 */
export function pickHosts(servers, opts = {}) {
  const suffix = String(opts.suffix ?? CONTENT_DOMAIN)
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');

  if (suffix === '') {
    return [];
  }

  /** @type {string[]} */
  const picked = [];
  const seen = new Set();
  // 国内网络下 cacheN-tyo3 这类东京节点延迟高且频繁超时，排到最后；
  // 全部都是远端节点时保持原顺序（总比没有强）。
  const isFar = (host) => /-tyo\d*\./i.test(host);

  for (const entry of hostEntries(servers)) {
    const host = normalizeHost(entry);
    if (host === null) {
      continue;
    }

    if (host !== suffix && !host.endsWith(`.${suffix}`)) {
      continue;
    }

    if (seen.has(host)) {
      continue;
    }

    seen.add(host);
    picked.push(host);
  }

  if (picked.length > 1) {
    const near = picked.filter((host) => !isFar(host));
    // 只有存在近端节点时才重排，否则保持原样
    if (near.length > 0 && near.length < picked.length) {
      return [...near, ...picked.filter((host) => isFar(host))];
    }
  }

  return picked;
}
