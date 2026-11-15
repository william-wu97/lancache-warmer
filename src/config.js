import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const DEFAULT_PORT = 8080;

// Local development fallback for the lancache cache root. Containers set
// CACHE_DATA_DIR explicitly (see docker-compose.yml).
const DEFAULT_CACHE_DIR = path.resolve(
  fileURLToPath(new URL('../data/cache', import.meta.url)),
);

// Local development fallback for the warmer's own data (game library, settings
// and icon cache). Containers mount WARMER_DATA_DIR at /app/data.
const DEFAULT_DATA_DIR = path.resolve(
  fileURLToPath(new URL('../data/', import.meta.url)),
);

/**
 * Parse a port from an environment variable, falling back to the default.
 * Throws on invalid values so the process fails fast instead of listening
 * somewhere unexpected.
 *
 * @param {string | undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function parsePort(value, fallback) {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got "${value}"`);
  }

  return port;
}

/**
 * Runtime configuration. Everything that can differ per deployment comes from
 * the environment; paths are derived from this module's location so the app can
 * run from any working directory and never hard-codes an absolute path.
 */
const config = Object.freeze({
  port: parsePort(process.env.PORT, DEFAULT_PORT),
  // Bind all interfaces when unset (Node's default), which is what containers
  // and reverse proxies expect.
  host: process.env.HOST || undefined,
  version: packageJson.version,
  webRoot: path.resolve(fileURLToPath(new URL('../web/', import.meta.url))),
  // The warmer's own data volume: game library, settings and icon cache.
  // Containers mount WARMER_DATA_DIR at /app/data (see docker-compose.yml).
  dataDir: path.resolve(process.env.WARMER_DATA_DIR || DEFAULT_DATA_DIR),
  // Root of the lancache data volume. The warmer only reads it, to report how
  // much content is cached and which Steam depots are present.
  cacheDir: path.resolve(process.env.CACHE_DATA_DIR || DEFAULT_CACHE_DIR),
});

export default config;
