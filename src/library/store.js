import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import config from '../config.js';

const LIBRARY_FILENAME = 'library.json';
const TEMP_FILE_SUFFIX = '.tmp';

/**
 * @typedef {Object} LibraryItem
 * @property {number} appid Steam application id.
 * @property {string} name Human readable game name.
 * @property {number} addedAt Unix timestamp in seconds of the first add.
 */

/**
 * @typedef {Object} Library
 * @property {LibraryItem[]} items
 */

// add() and remove() are read-modify-write cycles, so writes to the same file
// are serialised: without this, two concurrent requests could both read the old
// library and the last writer would silently drop the other change. Reads stay
// lock-free because a write replaces the file atomically.
/** @type {Map<string, Promise<void>>} */
const writeQueues = new Map();

/**
 * @param {string} dataDir
 * @returns {string}
 */
function libraryPath(dataDir) {
  return path.join(dataDir, LIBRARY_FILENAME);
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
 * @param {unknown} name
 * @returns {asserts name is string}
 */
function assertName(name) {
  if (typeof name !== 'string') {
    throw new TypeError('name must be a string');
  }
}

/**
 * Read and parse the library. A missing file is an empty library, not an error;
 * malformed JSON is reported instead of being silently replaced, so a damaged
 * file cannot wipe the user's library on the next write.
 *
 * @param {string} filePath
 * @returns {Promise<Library>}
 */
async function readLibrary(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return { items: [] };
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Library file ${filePath} is not valid JSON`);
  }

  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
    throw new Error(`Library file ${filePath} does not contain an "items" array`);
  }

  return { items: parsed.items };
}

/**
 * Replace the library atomically. The JSON is written to a temporary file in
 * the same directory and then renamed over the target, so a process killed
 * mid-write leaves the previous library intact instead of a truncated file.
 *
 * @param {string} filePath
 * @param {Library} library
 */
async function writeLibrary(filePath, library) {
  const dataDir = path.dirname(filePath);
  // First write creates the data directory; reads never do.
  await mkdir(dataDir, { recursive: true });

  // The temporary file must live on the same filesystem as the target for
  // rename() to be atomic.
  const tempPath = path.join(
    dataDir,
    `${LIBRARY_FILENAME}.${process.pid}.${randomUUID()}${TEMP_FILE_SUFFIX}`,
  );

  try {
    await writeFile(tempPath, `${JSON.stringify(library, null, 2)}\n`, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

/**
 * Run a write task after the previous write for the same file has settled.
 * Failures are kept out of the queue so one bad write cannot block later ones.
 *
 * @template T
 * @param {string} filePath
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function withWriteLock(filePath, task) {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const tail = run.catch(() => {});
  writeQueues.set(filePath, tail);

  return run.finally(() => {
    if (writeQueues.get(filePath) === tail) {
      writeQueues.delete(filePath);
    }
  });
}

/**
 * Add a game to the library or update the name of an appid already present.
 * The original `addedAt` timestamp is preserved when updating.
 *
 * @param {number} appid
 * @param {string} name
 * @param {string} [dataDir] Defaults to `config.dataDir` (`WARMER_DATA_DIR`).
 * @returns {Promise<{ created: boolean }>}
 */
export async function add(appid, name, dataDir = config.dataDir) {
  assertAppid(appid);
  assertName(name);

  const filePath = libraryPath(dataDir);

  return withWriteLock(filePath, async () => {
    const library = await readLibrary(filePath);
    const existing = library.items.find((item) => item.appid === appid);

    if (existing) {
      existing.name = name;
      await writeLibrary(filePath, library);
      return { created: false };
    }

    library.items.push({
      appid,
      name,
      addedAt: Math.floor(Date.now() / 1000),
    });
    await writeLibrary(filePath, library);
    return { created: true };
  });
}

/**
 * Remove a game from the library.
 *
 * @param {number} appid
 * @param {string} [dataDir] Defaults to `config.dataDir` (`WARMER_DATA_DIR`).
 * @returns {Promise<boolean>} False when the appid was not in the library.
 */
export async function remove(appid, dataDir = config.dataDir) {
  assertAppid(appid);

  const filePath = libraryPath(dataDir);

  return withWriteLock(filePath, async () => {
    const library = await readLibrary(filePath);
    const index = library.items.findIndex((item) => item.appid === appid);

    if (index === -1) {
      return false;
    }

    library.items.splice(index, 1);
    await writeLibrary(filePath, library);
    return true;
  });
}

/**
 * List every game, sorted by appid ascending. The returned array is a fresh
 * copy, so callers cannot mutate the stored library through it.
 *
 * @param {string} [dataDir] Defaults to `config.dataDir` (`WARMER_DATA_DIR`).
 * @returns {Promise<LibraryItem[]>}
 */
export async function list(dataDir = config.dataDir) {
  const { items } = await readLibrary(libraryPath(dataDir));
  return [...items].sort((left, right) => left.appid - right.appid);
}

/**
 * Search the library by appid substring or case-insensitive name substring.
 * An empty (or omitted) keyword matches everything.
 *
 * @param {string} [keyword]
 * @param {string} [dataDir] Defaults to `config.dataDir` (`WARMER_DATA_DIR`).
 * @returns {Promise<LibraryItem[]>}
 */
export async function search(keyword, dataDir = config.dataDir) {
  const items = await list(dataDir);

  if (keyword === undefined || keyword === null || keyword === '') {
    return items;
  }

  const needle = String(keyword).toLowerCase();

  return items.filter(
    (item) => String(item.appid).includes(String(keyword))
      || String(item.name).toLowerCase().includes(needle),
  );
}
