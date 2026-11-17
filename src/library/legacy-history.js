/**
 * Reads the download history of the old Python cache-manager.
 *
 * The legacy panel kept `data/history.json` next to its own state:
 *
 *   { "413150": { "cached_at": 1794752874 }, "1057090": { "cached_at": 1791039081 } }
 *
 * i.e. app id → when it was last prefilled. Migrating these into the warmer's
 * library saves the user from re-typing the ids they obviously care about.
 *
 * The file belongs to another program, so parsing is defensive: anything
 * unreadable yields an empty list.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import config from '../config.js';

export const LEGACY_HISTORY_FILE = 'history.json';
/** SteamPrefill 的勾选列表；history.json 漏记的游戏通常还留在这里。 */
export const SELECTED_APPS_FILE = 'selectedAppsToPrefill.json';

/**
 * @typedef {object} LegacyEntry
 * @property {number} appid
 * @property {number} cachedAt Unix seconds; 0 when the source had no timestamp.
 */

/**
 * @param {object} [opts]
 * @param {string} [opts.dir] Directory holding history.json; defaults to
 *   `config.legacyStateDir` (`LEGACY_STATE_DIR`).
 * @returns {Promise<{ available: boolean, file: string, entries: LegacyEntry[] }>}
 */
export async function readLegacyHistory(opts = {}) {
  const dir = opts.dir ?? config.legacyStateDir;
  const file = dir ? path.join(dir, LEGACY_HISTORY_FILE) : '';
  const empty = { available: false, file, entries: [] };

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
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return empty;
  }

  /** @type {LegacyEntry[]} */
  const entries = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (!/^\d+$/.test(key)) {
      continue;
    }
    const appid = Number(key);
    if (!Number.isSafeInteger(appid) || appid <= 0) {
      continue;
    }
    const cachedAt = value && typeof value === 'object' && Number.isFinite(value.cached_at)
      ? value.cached_at
      : 0;
    entries.push({ appid, cachedAt });
  }

  // SteamPrefill 的勾选列表里常有 history.json 没记上的游戏（例如下一个
  // 要下载的），一并合并进来，标记来源方便前端区分。
  const fromSelected = await readSelectedApps();
  const known = new Set(entries.map((item) => item.appid));
  for (const appid of fromSelected) {
    if (!known.has(appid)) {
      entries.push({ appid, cachedAt: 0, source: 'selected' });
      known.add(appid);
    }
  }
  for (const entry of entries) {
    if (!entry.source) entry.source = 'history';
  }

  // 有下载时间的在前（新到旧），没时间的（仅勾选）排后面
  entries.sort((left, right) => right.cachedAt - left.cachedAt);

  return { available: true, file, entries };
}

/**
 * SteamPrefill 里被勾选的 app id。
 * @returns {Promise<number[]>}
 */
async function readSelectedApps() {
  const dir = config.prefillStateDir;
  if (!dir) {
    return [];
  }
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, SELECTED_APPS_FILE), 'utf8'));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => Number(item))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
  } catch {
    return [];
  }
}
