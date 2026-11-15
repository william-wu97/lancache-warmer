import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import config from '../config.js';

const DEPOT_DIR_PATTERN = /^depot_(\d+)$/;
const BYTES_PER_GB = 1024 ** 3;

/**
 * @typedef {Object} DepotStats
 * @property {number} bytes
 * @property {number} files
 */

/**
 * @typedef {Object} CacheStats
 * @property {boolean} available
 * @property {number} bytes
 * @property {number} gb
 * @property {number} files
 * @property {Record<string, DepotStats>} depots
 */

/**
 * Walk a directory tree and accumulate the regular files that live under a
 * `depot_<digits>` directory.
 *
 * Symlinks are not followed: their compatibility with lancache is unknown and
 * following them could count the same file twice or loop forever.
 *
 * @param {string} dir
 * @param {string | null} depotId Depot name inherited from an ancestor.
 * @param {{ bytes: number, files: number, depots: Record<string, DepotStats> }} totals
 */
async function collect(dir, depotId, totals) {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const match = DEPOT_DIR_PATTERN.exec(entry.name);
      await collect(entryPath, match ? match[1] : depotId, totals);
      continue;
    }

    // Files outside any depot directory belong to other cache keys or to
    // lancache's own bookkeeping and must not be counted.
    if (depotId === null || !entry.isFile()) {
      continue;
    }

    const { size } = await stat(entryPath);
    totals.bytes += size;
    totals.files += 1;

    const depot = totals.depots[depotId] ?? { bytes: 0, files: 0 };
    depot.bytes += size;
    depot.files += 1;
    totals.depots[depotId] = depot;
  }
}

/**
 * Scan a lancache cache directory and report which Steam depots it holds.
 *
 * The scan is read-only: it only reads directory listings and file metadata,
 * never creates, deletes or rewrites anything. A missing directory is not an
 * error; callers get `{ available: false }` instead so the panel can render an
 * empty state.
 *
 * The directory is walked recursively and every regular file below a
 * `depot_<digits>` directory is counted, so both `<cache>/steam/depot_123/...`
 * and the nested `<cache>/cache/steam/depot_123/...` layout work.
 *
 * @param {string} [cacheDir] Cache root; defaults to `config.cacheDir`
 *   (`CACHE_DATA_DIR`).
 * @returns {Promise<CacheStats | { available: false }>}
 */
export async function scanCache(cacheDir = config.cacheDir) {
  let root;
  try {
    root = await stat(cacheDir);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return { available: false };
    }
    throw error;
  }

  if (!root.isDirectory()) {
    return { available: false };
  }

  const totals = {
    bytes: 0,
    files: 0,
    depots: /** @type {Record<string, DepotStats>} */ ({}),
  };
  await collect(cacheDir, null, totals);

  return {
    available: true,
    bytes: totals.bytes,
    gb: totals.bytes / BYTES_PER_GB,
    files: totals.files,
    depots: totals.depots,
  };
}
