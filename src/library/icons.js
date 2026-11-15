import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import config from '../config.js';

const ICONS_DIRNAME = 'icons';
const ICON_EXTENSION = '.jpg';
const ICON_URL_PREFIX = 'https://cdn.cloudflare.steamstatic.com/steam/apps/';
const ICON_URL_SUFFIX = '/header.jpg';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * @typedef {Object} IconResult
 * @property {string | null} path Absolute path of the cached icon, or null on failure.
 * @property {boolean} cached Whether the file was already on disk.
 */

/**
 * @typedef {Object} IconErrorResult
 * @property {null} path
 * @property {Error} error
 */

/**
 * @typedef {Object} GetIconOptions
 * @property {string} [dataDir] Data directory; defaults to `config.dataDir`
 *   (`WARMER_DATA_DIR`).
 * @property {typeof fetch} [fetcher] Download function; defaults to global
 *   `fetch`. Tests inject a fake so they never touch the network.
 * @property {number} [timeoutMs] Download timeout; defaults to 10 seconds.
 */

/**
 * One promise per target file, so concurrent misses for the same appid share a
 * single download instead of racing each other.
 *
 * @type {Map<string, Promise<IconResult | IconErrorResult>>}
 */
const inFlightDownloads = new Map();

/**
 * @param {string} dataDir
 * @param {number} appid
 * @returns {string}
 */
function iconPath(dataDir, appid) {
  return path.join(dataDir, ICONS_DIRNAME, `${appid}${ICON_EXTENSION}`);
}

/**
 * @param {number} appid
 * @returns {string}
 */
function iconUrl(appid) {
  return `${ICON_URL_PREFIX}${appid}${ICON_URL_SUFFIX}`;
}

/**
 * @param {unknown} appid
 * @returns {asserts appid is number}
 */
function assertAppid(appid) {
  if (!Number.isSafeInteger(appid) || appid <= 0) {
    throw new TypeError(`appid must be a positive safe integer, got ${String(appid)}`);
  }
}

/**
 * @param {unknown} response
 * @param {number} appid
 * @returns {void}
 */
function assertOk(response, appid) {
  if (response === null || typeof response !== 'object') {
    throw new Error(`Icon download for appid ${appid} returned an invalid response`);
  }

  const { ok, status } = /** @type {{ ok?: boolean, status?: number }} */ (response);
  if (ok === false || (typeof status === 'number' && status >= 400)) {
    throw new Error(`Icon download for appid ${appid} failed with HTTP ${String(status)}`);
  }
}

/**
 * Download an icon into the cache. The body is written to a temporary file in
 * the target directory and renamed into place only after it was fully written,
 * so a failed or interrupted download never leaves a readable half image at the
 * cache path. Every failure path returns `{ path: null, error }` instead of
 * throwing: a missing cover must not take down the caller.
 *
 * @param {number} appid
 * @param {string} filePath
 * @param {GetIconOptions} opts
 * @returns {Promise<IconResult | IconErrorResult>}
 */
async function downloadIcon(appid, filePath, opts) {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = iconUrl(appid);
  let tempPath;

  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
    assertOk(response, appid);

    const body = Buffer.from(await response.arrayBuffer());
    const directory = path.dirname(filePath);
    await mkdir(directory, { recursive: true });

    // The temporary file must live on the same filesystem as the target for
    // rename() to be atomic.
    tempPath = path.join(
      directory,
      `.${appid}.${process.pid}.${randomUUID()}.tmp`,
    );
    await writeFile(tempPath, body);
    await rename(tempPath, filePath);

    return { path: filePath, cached: false };
  } catch (error) {
    if (tempPath !== undefined) {
      await rm(tempPath, { force: true });
    }
    return { path: null, error: normalizeError(error) };
  }
}

/**
 * Coerce whatever a fetcher rejected with into an Error, so callers always get
 * a usable `error` field even for string or undefined rejections.
 *
 * @param {unknown} error
 * @returns {Error}
 */
function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Return the local cover image for a Steam app, downloading it on first use.
 *
 * On a cache hit no network request is made. On a miss the image is stored at
 * `<DATA_DIR>/icons/<appid>.jpg`; concurrent misses for the same appid share one
 * download. Download problems (network error, HTTP error, timeout) resolve to
 * `{ path: null, error }` and leave no partial file behind.
 *
 * @param {number} appid Steam application id.
 * @param {GetIconOptions} [opts]
 * @returns {Promise<IconResult | IconErrorResult>}
 */
export async function getIcon(appid, opts = {}) {
  assertAppid(appid);

  const dataDir = opts.dataDir ?? config.dataDir;
  const filePath = iconPath(dataDir, appid);

  try {
    const stats = await stat(filePath);
    if (stats.isFile()) {
      return { path: filePath, cached: true };
    }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
      return { path: null, error: normalizeError(error) };
    }
  }

  const existing = inFlightDownloads.get(filePath);
  if (existing) {
    return existing;
  }

  const pending = downloadIcon(appid, filePath, opts).finally(() => {
    if (inFlightDownloads.get(filePath) === pending) {
      inFlightDownloads.delete(filePath);
    }
  });
  inFlightDownloads.set(filePath, pending);

  return pending;
}
