/**
 * Reads the cache inventory that SteamPrefill leaves behind.
 *
 * SteamPrefill writes `successfullyDownloadedDepots.json` next to its config:
 *
 *   { "413151": [4278718763097142923], "990381": [4578285982077398722] }
 *
 * i.e. depot id → manifest ids that were fully downloaded. This is far more
 * reliable than guessing from the lancache volume, whose nginx layout
 * (`cache/<2 hex>/<2 hex>/<key>`) carries no depot information at all.
 *
 * The file is owned by another tool, so everything here is defensive: a
 * missing, unreadable or malformed inventory yields an empty result instead of
 * an exception.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import config from '../config.js';

/** SteamPrefill's file name; kept here so callers don't repeat the literal. */
export const INVENTORY_FILE = 'successfullyDownloadedDepots.json';

/**
 * @typedef {object} CachedDepot
 * @property {number} depotId
 * @property {string[]} manifestIds Manifest ids recorded for this depot.
 */

/**
 * @typedef {object} CachedInventory
 * @property {boolean} available Whether an inventory file was found and parsed.
 * @property {string} file Absolute path that was read.
 * @property {CachedDepot[]} depots Sorted by depot id, ascending.
 * @property {number} manifestCount Total manifest entries across all depots.
 */

/**
 * Normalise one raw entry into a list of manifest id strings.
 *
 * SteamPrefill has used both a plain array and a single scalar over time, and
 * large manifest ids do not survive a round trip through JSON numbers in every
 * language, so accept strings, numbers and arrays of either.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function toManifestIds(value) {
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of raw) {
    if (typeof item === 'string' && /^\d+$/.test(item)) {
      out.push(item);
    } else if (typeof item === 'number' && Number.isFinite(item) && item > 0) {
      // 安全整数范围内可以直接转字符串；超出范围时 JSON 解析本身就已经丢了精度，
      // 这里只能尽力而为。
      out.push(BigInt(Math.trunc(item)).toString());
    }
  }
  return out;
}

/**
 * Read the SteamPrefill inventory.
 *
 * @param {object} [opts]
 * @param {string} [opts.stateDir] Directory holding the inventory; defaults to
 *   `config.prefillStateDir` (`PREFILL_STATE_DIR`).
 * @returns {Promise<CachedInventory>}
 */
export async function readCachedDepots(opts = {}) {
  const stateDir = opts.stateDir ?? config.prefillStateDir;
  const file = stateDir ? path.join(stateDir, INVENTORY_FILE) : '';
  const empty = { available: false, file, depots: [], manifestCount: 0 };

  if (!file) {
    return empty;
  }

  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return empty;
  }

  let parsed;
  try {
    // Manifest ids exceed 2^53 (e.g. 7260605429366465749), so a plain
    // JSON.parse silently rounds them — and a wrong manifest id means every
    // chunk request 404s. The reviver's third argument carries the original
    // source text, which lets us keep the exact digits as a string.
    parsed = JSON.parse(raw, (key, value, context) => {
      if (typeof value === 'number' && !Number.isSafeInteger(value)) {
        return context?.source ?? String(value);
      }
      return value;
    });
  } catch {
    return empty;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return empty;
  }

  /** @type {CachedDepot[]} */
  const depots = [];
  let manifestCount = 0;

  for (const [key, value] of Object.entries(parsed)) {
    if (!/^\d+$/.test(key)) {
      continue;
    }
    const manifestIds = toManifestIds(value);
    if (manifestIds.length === 0) {
      continue;
    }
    manifestCount += manifestIds.length;
    depots.push({ depotId: Number(key), manifestIds });
  }

  // 合并 warmer 自己下载过的 depot：SteamPrefill 的清单只包含它下过的，
  // 不合并的话界面上永远看不到 warmer 新增的内容。
  const own = await readOwnDepots();
  const known = new Set(depots.map((item) => item.depotId));
  for (const entry of own) {
    if (!known.has(entry.depotId)) {
      depots.push(entry);
      manifestCount += entry.manifestIds.length;
      known.add(entry.depotId);
    }
  }

  depots.sort((left, right) => left.depotId - right.depotId);

  return { available: true, file, depots, manifestCount };
}

/**
 * warmer 自己记录的已下载 depot（见 task-runner 的 recordDepots）。
 *
 * @returns {Promise<Array<{ depotId: number, manifestIds: string[] }>>}
 */
async function readOwnDepots() {
  const file = path.join(config.dataDir, 'warmer-depots.json');
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    const depots = parsed?.depots;
    if (!depots || typeof depots !== 'object') {
      return [];
    }
    const out = [];
    for (const [key, value] of Object.entries(depots)) {
      if (!/^\d+$/.test(key)) continue;
      const ids = Array.isArray(value) ? value.map(String) : [];
      if (ids.length === 0) continue;
      out.push({ depotId: Number(key), manifestIds: ids });
    }
    return out;
  } catch {
    return [];
  }
}
