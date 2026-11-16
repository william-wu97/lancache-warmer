import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import config from '../../config.js';

const TOKEN_FILENAME = 'steam-token.json';
const TEMP_FILE_SUFFIX = '.tmp';
// Credentials: only the owner may read or write the file.
const TOKEN_FILE_MODE = 0o600;

/**
 * Steam login credential persisted on disk.
 *
 * @typedef {Object} SteamToken
 * @property {string} refreshToken Steam refresh token. Never log this value.
 * @property {number} savedAt Unix timestamp in seconds of when the token was saved.
 * @property {string} steamId 64-bit Steam id of the logged-in account.
 */

/**
 * @typedef {Object} TokenStoreOptions
 * @property {string} [dataDir] Data directory; defaults to `config.dataDir`
 *   (`WARMER_DATA_DIR`).
 */

/**
 * @param {string} dataDir
 * @returns {string}
 */
function tokenPath(dataDir) {
  return path.join(dataDir, TOKEN_FILENAME);
}

/**
 * Validate a token record. The documented record carries all three fields and
 * callers of `loadToken()` may rely on them being present, so a partial or
 * mistyped record is rejected instead of being written.
 *
 * Error messages never include field values: a failed save must not put
 * credentials in logs or error reports.
 *
 * @param {unknown} data
 * @returns {asserts data is SteamToken}
 */
function assertTokenData(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('token data must be an object');
  }

  const { refreshToken, savedAt, steamId } = /** @type {Record<string, unknown>} */ (data);

  if (typeof refreshToken !== 'string' || refreshToken.trim() === '') {
    throw new TypeError('refreshToken must be a non-empty string');
  }

  if (typeof savedAt !== 'number' || !Number.isSafeInteger(savedAt) || savedAt < 0) {
    throw new TypeError('savedAt must be a non-negative integer Unix timestamp');
  }

  if (typeof steamId !== 'string' || steamId.trim() === '') {
    throw new TypeError('steamId must be a non-empty string');
  }
}

/**
 * Whether a parsed JSON value is a usable token record. A damaged record is
 * anything that does not match the documented shape, including a missing field.
 *
 * @param {unknown} value
 * @returns {value is SteamToken}
 */
function isToken(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const { refreshToken, savedAt, steamId } = /** @type {Record<string, unknown>} */ (value);

  return typeof refreshToken === 'string' && refreshToken.trim() !== ''
    && typeof savedAt === 'number' && Number.isSafeInteger(savedAt) && savedAt >= 0
    && typeof steamId === 'string' && steamId.trim() !== '';
}

/**
 * Read the token file. A missing file means "not logged in", and a damaged file
 * (unparseable JSON or a record that does not match the documented shape) is
 * treated the same way instead of taking the caller down. Other filesystem
 * errors, such as a permission problem, are propagated because they need
 * attention.
 *
 * @param {string} filePath
 * @returns {Promise<SteamToken | null>}
 */
async function readToken(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return isToken(parsed) ? parsed : null;
}

/**
 * Persist Steam credentials at `<dataDir>/steam-token.json`.
 *
 * The record must contain all documented fields; a missing or empty
 * `refreshToken` (or an otherwise invalid record) throws a `TypeError` before
 * anything is written.
 *
 * The file is written to a temporary sibling first and then renamed into place,
 * so a crash mid-write cannot leave a truncated token behind. The temporary
 * file is created with mode 600 and chmod'ed explicitly, because writeFile's
 * mode is filtered by the process umask.
 *
 * @param {SteamToken} data
 * @param {TokenStoreOptions} [opts]
 * @returns {Promise<void>}
 */
export async function saveToken(data, opts = {}) {
  assertTokenData(data);

  const dataDir = opts.dataDir ?? config.dataDir;
  const filePath = tokenPath(dataDir);

  // First save creates the data directory; loading never does.
  await mkdir(dataDir, { recursive: true });

  // The temporary file must live on the same filesystem as the target for
  // rename() to be atomic.
  const tempPath = path.join(
    dataDir,
    `.${TOKEN_FILENAME}.${process.pid}.${randomUUID()}${TEMP_FILE_SUFFIX}`,
  );

  try {
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: 'utf8',
      mode: TOKEN_FILE_MODE,
    });
    // writeFile applies the mode through the umask, so force the exact bits.
    await chmod(tempPath, TOKEN_FILE_MODE);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

/**
 * Load Steam credentials from `<dataDir>/steam-token.json`.
 *
 * A missing or damaged file resolves to `null` so callers can treat it as "not
 * logged in"; only unexpected filesystem errors are thrown.
 *
 * @param {TokenStoreOptions} [opts]
 * @returns {Promise<SteamToken | null>}
 */
export async function loadToken(opts = {}) {
  return readToken(tokenPath(opts.dataDir ?? config.dataDir));
}

/**
 * Delete the stored Steam credentials. Clearing when nothing is stored is a
 * no-op.
 *
 * @param {TokenStoreOptions} [opts]
 * @returns {Promise<void>}
 */
export async function clearToken(opts = {}) {
  await rm(tokenPath(opts.dataDir ?? config.dataDir), { force: true });
}
