/**
 * Resolves app ids to game names through Steam's product info.
 *
 * Used after importing the legacy download history, which only carries ids.
 * Names rarely change, so results are cached on disk for a day.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import config from '../config.js';

const CACHE_FILE = 'app-names.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Steam accepts a list, but keep batches modest to stay well inside limits. */

/**
 * @typedef {object} AppNameResult
 * @property {Record<string, string>} names appid → name
 * @property {number[]} unresolved Ids Steam did not know.
 * @property {string} [note] Why a lookup was skipped, when it was.
 */

/**
 * @param {number[]} appIds
 * @param {object} [opts]
 * @param {boolean} [opts.refresh]
 * @param {(o: { refreshToken: string }) => Promise<any>} [opts.connectFn]
 * @param {string} [opts.dataDir]
 * @returns {Promise<AppNameResult>}
 */
export async function resolveAppNames(appIds, opts = {}) {
  const wanted = [...new Set(
    (Array.isArray(appIds) ? appIds : [])
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  )];

  if (wanted.length === 0) {
    return { names: {}, unresolved: [] };
  }

  const dataDir = opts.dataDir ?? config.dataDir;
  const cachePath = path.join(dataDir, CACHE_FILE);
  const cached = opts.refresh ? {} : await readCache(cachePath);

  const names = {};
  const missing = [];
  for (const appId of wanted) {
    const hit = cached[String(appId)];
    if (typeof hit === 'string' && hit !== '') {
      names[String(appId)] = hit;
    } else {
      missing.push(appId);
    }
  }

  if (missing.length === 0) {
    return { names, unresolved: [] };
  }

  // 这里不再单独查 Steam：getProductInfo 会拉回完整 appinfo（几十秒），
  // 而 store API 在某些网络下不可达。名字由 /api/depot-names 那次查询
  // 顺带写入同一个缓存，此处只负责读。
  return {
    names,
    unresolved: missing,
    note: missing.length > 0 ? '这些 appid 还没有名字缓存，请先访问 /api/depot-names 触发一次查询' : undefined,
  };


  if (Object.keys(fetched).length > 0) {
    await writeCache(cachePath, { ...cached, ...fetched });
  }

  return { names, unresolved };
}

/**
 * @param {string} file
 * @returns {Promise<Record<string, string>>}
 */
async function readCache(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    if (typeof parsed.savedAt !== 'number') return {};
    if (Date.now() - parsed.savedAt > CACHE_TTL_MS) return {};
    return parsed.names && typeof parsed.names === 'object' ? parsed.names : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} file
 * @param {Record<string, string>} names
 */
async function writeCache(file, names) {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ savedAt: Date.now(), names }, null, 2));
  } catch {
    // 缓存写失败不影响本次返回
  }
}
