/**
 * Steam app/depot/chunk metadata queries.
 *
 * These helpers only fetch and parse metadata: no chunk content is downloaded
 * and nothing is written to disk. Callers pass in an authenticated `steam-user`
 * instance, so the network side stays outside this module and tests can supply
 * a fake.
 *
 * Steam's content manifest parser lives in a commonjs component module rather
 * than the package's main entry. It is required lazily through a `require`
 * created from this ES module, which keeps the documented import path
 * (`steam-user/components/content_manifest`) working and keeps the dependency
 * out of the test path, where `opts.parseManifest` is injected.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const DEFAULT_OS_FILTER = 'windows';

// Start with one request, then retry twice as the issue specifies.
const MANIFEST_FETCH_ATTEMPTS = 3;

/**
 * Shape returned by `steam-user`'s `getProductInfo` for one app's `appinfo`.
 *
 * @typedef {Object} AppInfo
 * @property {Record<string, object>} [depots] Depots keyed by depot id; the
 *   same object also holds non-depot keys such as `branches`.
 */

/**
 * Fetch options for depot selection.
 *
 * @typedef {Object} CollectDepotsOptions
 * @property {string} [osFilter] Platform that a depot's `config.oslist` must
 *   include to be kept. Defaults to `windows`. A depot without an oslist (or
 *   with an empty one) is shared and is always kept.
 */

/**
 * Fetch options for chunk collection.
 *
 * @typedef {Object} CollectChunksOptions
 * @property {(manifest: Buffer) => { files?: { chunks?: object[] }[] }} [parseManifest]
 *   Manifest parser. Defaults to `steam-user`'s content manifest parser; tests
 *   inject a function that returns a pre-built manifest object so they never
 *   need the binary format or a network connection.
 */

/**
 * One branch manifest of a depot.
 *
 * @typedef {Object} DepotManifest
 * @property {number} depotId
 * @property {string} manifestId
 * @property {number} size
 */

/**
 * One content chunk, deduplicated across files.
 *
 * @typedef {Object} ContentChunk
 * @property {string} sha
 * @property {number} size Compressed size in bytes, the amount downloaded for
 *   the chunk.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Turn a depot's `config.oslist` into a list of platform names.
 *
 * Steam stores the list as a comma-separated string, but appinfo dumps have
 * also been seen as arrays. A missing, empty or unrecognised value yields an
 * empty list, which callers treat as a shared depot.
 *
 * @param {unknown} oslist
 * @returns {string[]}
 */
function parseOsList(oslist) {
  const raw = Array.isArray(oslist) ? oslist : typeof oslist === 'string' ? oslist.split(',') : [];

  return raw
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
}

/**
 * Whether a depot applies to the requested platform. An empty oslist means the
 * depot is shared by every platform and is kept.
 *
 * @param {Record<string, any>} depot
 * @param {string} osFilter Lower-case platform name.
 * @returns {boolean}
 */
function depotMatchesOs(depot, osFilter) {
  const platforms = parseOsList(depot.config?.oslist);
  return platforms.length === 0 || platforms.includes(osFilter);
}

/**
 * Select the public branch of every app depot that applies to a platform.
 *
 * Only depots with a `manifests.public` entry are returned: a depot without a
 * public manifest has no build the warmer could fetch. Non-depot keys of
 * `appInfo.depots` (for example `branches`) are ignored because their keys are
 * not numeric depot ids.
 *
 * @param {AppInfo} appInfo
 * @param {CollectDepotsOptions} [opts]
 * @returns {DepotManifest[]}
 */
export function collectDepots(appInfo, opts = {}) {
  const depots = isObject(appInfo) && isObject(appInfo.depots) ? appInfo.depots : null;
  if (depots === null) {
    return [];
  }

  const osFilter = String(opts.osFilter ?? DEFAULT_OS_FILTER).trim().toLowerCase();
  /** @type {DepotManifest[]} */
  const selected = [];

  for (const [key, depot] of Object.entries(depots)) {
    const depotId = Number(key);
    if (!Number.isSafeInteger(depotId) || depotId <= 0 || !isObject(depot)) {
      continue;
    }

    const publicManifest = depot.manifests?.public;
    // Current appinfo is `{ gid, size }`; older dumps stored the gid directly.
    // steam-user accepts both, so accept both here too.
    const manifestId = typeof publicManifest === 'string'
      ? publicManifest
      : isObject(publicManifest) && typeof publicManifest.gid === 'string'
        ? publicManifest.gid
        : null;
    if (manifestId === null || manifestId === '') {
      continue;
    }

    if (!depotMatchesOs(depot, osFilter)) {
      continue;
    }

    const size = isObject(publicManifest) ? publicManifest.size : undefined;
    selected.push({
      depotId,
      manifestId,
      size: typeof size === 'number' && Number.isFinite(size) ? size : 0,
    });
  }

  return selected;
}

/**
 * Flatten `files[].chunks[]` into one list, keeping the first occurrence of
 * each sha. Distinct files commonly reference the same chunk, so callers must
 * not download it twice.
 *
 * @param {unknown} parsed Manifest returned by the parser.
 * @returns {ContentChunk[]}
 */
function flattenChunks(parsed) {
  /** @type {ContentChunk[]} */
  const chunks = [];
  const seen = new Set();

  const files = isObject(parsed) && Array.isArray(parsed.files) ? parsed.files : [];
  for (const file of files) {
    const fileChunks = isObject(file) && Array.isArray(file.chunks) ? file.chunks : [];

    for (const chunk of fileChunks) {
      if (!isObject(chunk)) {
        continue;
      }

      const { sha } = chunk;
      if (typeof sha !== 'string' || sha === '') {
        continue;
      }

      // Hex ids are case-insensitive; compare in one case but keep the value
      // exactly as Steam returned it.
      const dedupKey = sha.toLowerCase();
      if (seen.has(dedupKey)) {
        continue;
      }
      seen.add(dedupKey);

      // `cb_compressed` is the number of bytes transferred for the chunk,
      // which is what cache warming actually downloads.
      const size = typeof chunk.cb_compressed === 'number' && Number.isFinite(chunk.cb_compressed)
        ? chunk.cb_compressed
        : 0;

      chunks.push({ sha, size });
    }
  }

  return chunks;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Call `getRawManifest` for the depot's public branch, retrying a failed
 * request. A rejected promise means every attempt failed; the original error
 * is kept as the cause.
 *
 * @param {{ getRawManifest: Function }} user
 * @param {number} appId
 * @param {DepotManifest} depot
 * @returns {Promise<{ manifest: Buffer }>}
 */
async function fetchRawManifest(user, appId, depot) {
  let lastError;

  for (let attempt = 1; attempt <= MANIFEST_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const raw = await user.getRawManifest(appId, depot.depotId, depot.manifestId, 'public');

      if (!isObject(raw) || raw.manifest === undefined || raw.manifest === null) {
        throw new TypeError('getRawManifest did not return a manifest payload');
      }

      return /** @type {{ manifest: Buffer }} */ (raw);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Failed to fetch manifest ${depot.manifestId} for depot ${depot.depotId} `
      + `after ${MANIFEST_FETCH_ATTEMPTS} attempts: ${errorMessage(lastError)}`,
    { cause: lastError },
  );
}

/**
 * Fetch one depot's public manifest and return its deduplicated chunk list.
 *
 * Fetching is retried twice (three requests in total); a persistent failure
 * rejects with an error that identifies the depot. Parsing failures are not
 * retried because the request itself succeeded, but they also carry the depot
 * id. Nothing is downloaded or written beyond the manifest itself.
 *
 * @param {{ getRawManifest: Function }} user Authenticated `steam-user`
 *   instance, or a fake in tests.
 * @param {number} appId
 * @param {DepotManifest} depot Entry returned by `collectDepots`.
 * @param {CollectChunksOptions} [opts]
 * @returns {Promise<ContentChunk[]>}
 */
export async function collectChunks(user, appId, depot, opts = {}) {
  const raw = await fetchRawManifest(user, appId, depot);
  const parseManifest = opts.parseManifest ?? defaultParseManifest;

  let parsed;
  try {
    parsed = parseManifest(raw.manifest);
  } catch (error) {
    throw new Error(
      `Failed to parse manifest ${depot.manifestId} for depot ${depot.depotId}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  return flattenChunks(parsed);
}

/**
 * Default parser: `steam-user`'s content manifest component. Required lazily so
 * tests that inject `opts.parseManifest` never load it.
 *
 * @param {Buffer} manifest
 * @returns {{ files?: { chunks?: object[] }[] }}
 */
function defaultParseManifest(manifest) {
  return require('steam-user/components/content_manifest').parse(manifest);
}
