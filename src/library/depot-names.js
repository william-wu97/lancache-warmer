/**
 * Maps depot ids to human-readable names.
 *
 * Steam has no public "depot → app" lookup: `getProductInfo` goes the other
 * way (app → depots). So there are two sources, cheap to expensive:
 *
 *  1. A small built-in table for depots everyone has.
 *  2. Reverse lookup through the user's own library — for each app the user
 *     keeps, ask Steam which depots it owns and record `depotId → app name`.
 *
 * Anything still unresolved is simply absent; callers fall back to the id.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import config from '../config.js';
import { connect } from '../providers/steam/client.js';
import { loadToken } from '../providers/steam/token-store.js';
import { readCachedDepots } from './cached-depots.js';
import { list } from './store.js';

const CACHE_FILE = 'depot-names.json';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Depots that do not belong to a single game, or are so common that asking
 * Steam for them is a waste of a round trip.
 */
const KNOWN_DEPOTS = {
  228980: 'Steamworks Common Redistributables',
  229002: 'Steamworks Common Redistributables',
  229003: 'Steamworks Common Redistributables',
  229004: 'Steamworks Common Redistributables',
  229005: 'Steamworks Common Redistributables',
  229006: 'Steamworks Common Redistributables',
  229007: 'Steamworks Common Redistributables',
  229033: 'Steam Linux Runtime',
  1070560: 'Steam Linux Runtime 1.0 (scout)',
  1391110: 'Steam Linux Runtime 2.0 (soldier)',
  1628350: 'Steam Linux Runtime 3.0 (sniper)',
};

/**
 * @typedef {object} DepotNameMap
 * @property {Record<string, string>} names depot id → display name
 * @property {boolean} resolvedFromSteam Whether a live lookup contributed
 * @property {string} [note] Why the lookup was skipped, when it was
 */

/**
 * @param {object} [opts]
 * @param {boolean} [opts.refresh] Ignore the cached map and re-query Steam.
 * @param {(o: {refreshToken: string}) => Promise<any>} [opts.connectFn]
 * @param {string} [opts.dataDir]
 * @returns {Promise<DepotNameMap>}
 */
export async function resolveDepotNames(opts = {}) {
  const dataDir = opts.dataDir ?? config.dataDir;
  const cachePath = path.join(dataDir, CACHE_FILE);

  if (!opts.refresh) {
    const cached = await readCache(cachePath);
    if (cached) {
      return { names: { ...KNOWN_DEPOTS, ...cached.names }, resolvedFromSteam: true };
    }
  }

  // Only depots that actually appear in the inventory are worth resolving.
  const inventory = await readCachedDepots();
  const wanted = new Set(inventory.depots.map((item) => String(item.depotId)));

  const names = {};
  let note;

  const games = await list();
  if (games.length === 0) {
    note = '游戏库为空，只有内置表可用';
  } else if (wanted.size === 0) {
    note = '没有已缓存的 depot 需要解析';
  } else {
    try {
      const token = await loadToken();
      if (!token?.refreshToken) {
        note = '未登录 Steam，只有内置表可用';
      } else {
        const connectFn = opts.connectFn ?? connect;
        const user = await connectFn({ refreshToken: token.refreshToken });
        await mapThroughLibrary(user, games, wanted, names);
        const matched = Object.keys(names).length;
        const missed = wanted.size - matched;
        // 说清楚为什么有些 depot 没名字：Steam 只有 app→depots 这一个方向，
        // 库里没有对应游戏时反向映射就推不出来。
        note = matched > 0
          ? `已比对 ${games.length} 个游戏，识别 ${matched} 个 depot，${missed} 个未匹配`
          : `已比对 ${games.length} 个游戏，但都不含这些 depot（库里的游戏太少？）`;
        await writeCache(cachePath, names);
      }
    } catch (error) {
      note = `查询 Steam 失败：${error.message}`;
    }
  }

  return {
    names: { ...KNOWN_DEPOTS, ...names },
    resolvedFromSteam: Object.keys(names).length > 0,
    ...(note ? { note } : {}),
  };
}

/**
 * Ask Steam for each app's depot list, keeping only the depots we care about.
 *
 * @param {any} user
 * @param {Array<{ appid: number, name: string }>} games
 * @param {Set<string>} wanted
 * @param {Record<string, string>} names Accumulator, mutated in place.
 */
async function mapThroughLibrary(user, games, wanted, names) {
  const remaining = new Set(wanted);
  // Batch the appids: one round trip per chunk instead of one per game.
  const BATCH = 25;
  for (let index = 0; index < games.length && remaining.size > 0; index += BATCH) {
    const chunk = games.slice(index, index + BATCH);
    const appIds = chunk.map((game) => game.appid);

    let productInfo;
    try {
      productInfo = await user.getProductInfo(appIds, []);
    } catch {
      continue;
    }

    for (const game of chunk) {
      const depots = productInfo?.apps?.[game.appid]?.appinfo?.depots;
      if (!depots || typeof depots !== 'object') {
        continue;
      }
      for (const depotId of Object.keys(depots)) {
        if (remaining.has(depotId)) {
          names[depotId] = game.name;
          remaining.delete(depotId);
        }
      }
    }
  }
}

/**
 * @param {string} file
 * @returns {Promise<{ names: Record<string, string> } | null>}
 */
async function readCache(file) {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.savedAt !== 'number') return null;
    if (Date.now() - parsed.savedAt > CACHE_TTL_MS) return null;
    if (!parsed.names || typeof parsed.names !== 'object') return null;
    return { names: parsed.names };
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @param {Record<string, string>} names
 */
async function writeCache(file, names) {
  if (Object.keys(names).length === 0) return;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ savedAt: Date.now(), names }, null, 2));
  } catch {
    // 缓存写不进去不影响本次结果，下次再查就是了
  }
}
