import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { getIcon } from '../src/library/icons.js';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const APPID = 413150;
const ICON_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const ICON_URL = `https://cdn.cloudflare.steamstatic.com/steam/apps/${APPID}/header.jpg`;

/**
 * Run a test against a fresh temporary data directory and always clean it up.
 *
 * @template T
 * @param {(dataDir: string) => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withTempDir(run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lancache-warmer-icons-'));
  try {
    return await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

/**
 * @param {number} [ms]
 * @returns {Promise<void>}
 */
function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a fetch-compatible recorder so tests assert on requests without ever
 * opening a network connection.
 *
 * @param {Buffer} [body]
 * @returns {{ fetcher: typeof fetch, calls: Array<{ url: string, options: RequestInit }> }}
 */
function recordingFetcher(body = ICON_BYTES) {
  /** @type {Array<{ url: string, options: RequestInit }>} */
  const calls = [];

  /** @type {typeof fetch} */
  const fetcher = async (input, options = {}) => {
    calls.push({ url: String(input), options });
    return new Response(body, { status: 200 });
  };

  return { fetcher, calls };
}

/**
 * List the icon cache directory, treating a missing directory as empty.
 *
 * @param {string} dataDir
 * @returns {Promise<string[]>}
 */
async function listIconFiles(dataDir) {
  try {
    return await readdir(path.join(dataDir, 'icons'));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
function iconPath(dataDir) {
  return path.join(dataDir, 'icons', `${APPID}.jpg`);
}

test('a cached icon is returned without calling the fetcher', async () => {
  await withTempDir(async (dataDir) => {
    await mkdir(path.join(dataDir, 'icons'), { recursive: true });
    await writeFile(iconPath(dataDir), ICON_BYTES);

    let calls = 0;
    /** @type {typeof fetch} */
    const fetcher = async () => {
      calls += 1;
      throw new Error('the fetcher must not run on a cache hit');
    };

    assert.deepEqual(
      await getIcon(APPID, { dataDir, fetcher }),
      { path: iconPath(dataDir), cached: true },
    );
    assert.equal(calls, 0);
    assert.deepEqual(await readFile(iconPath(dataDir)), ICON_BYTES);
  });
});

test('a missing icon is downloaded to DATA_DIR/icons and reported as fresh', async () => {
  await withTempDir(async (dataDir) => {
    const { fetcher, calls } = recordingFetcher();

    assert.deepEqual(
      await getIcon(APPID, { dataDir, fetcher }),
      { path: iconPath(dataDir), cached: false },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, ICON_URL);
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.deepEqual(await readFile(iconPath(dataDir)), ICON_BYTES);
    // Atomic write must not leave temporary files next to the icon.
    assert.deepEqual(await listIconFiles(dataDir), [`${APPID}.jpg`]);

    // The next call is served from disk.
    assert.deepEqual(
      await getIcon(APPID, { dataDir, fetcher }),
      { path: iconPath(dataDir), cached: true },
    );
    assert.equal(calls.length, 1);
  });
});

test('concurrent misses for the same appid share a single download', async () => {
  await withTempDir(async (dataDir) => {
    let calls = 0;
    /** @type {() => void} */
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    /** @type {typeof fetch} */
    const fetcher = async () => {
      calls += 1;
      await gate;
      return new Response(ICON_BYTES, { status: 200 });
    };

    const pending = Promise.all(
      Array.from({ length: 5 }, () => getIcon(APPID, { dataDir, fetcher })),
    );

    // Give every caller time to miss the cache and reach the in-flight map.
    await delay(25);
    const callsBeforeRelease = calls;
    release();

    const results = await pending;

    assert.equal(callsBeforeRelease, 1);
    assert.equal(calls, 1);
    for (const result of results) {
      assert.deepEqual(result, { path: iconPath(dataDir), cached: false });
    }
    assert.deepEqual(await readFile(iconPath(dataDir)), ICON_BYTES);

    // The in-flight entry is gone once the download settled.
    assert.deepEqual(
      await getIcon(APPID, { dataDir, fetcher }),
      { path: iconPath(dataDir), cached: true },
    );
    assert.equal(calls, 1);
  });
});

test('a failed download returns an error result and leaves no partial file', async () => {
  await withTempDir(async (dataDir) => {
    const failure = new Error('network down');
    /** @type {typeof fetch} */
    const fetcher = async () => {
      throw failure;
    };

    const result = await getIcon(APPID, { dataDir, fetcher });

    assert.equal(result.path, null);
    assert.equal(result.error, failure);
    assert.equal('cached' in result, false);
    assert.deepEqual(await listIconFiles(dataDir), []);
    await assert.rejects(stat(iconPath(dataDir)), { code: 'ENOENT' });
  });
});

test('a failed download is not remembered, so a later call can retry', async () => {
  await withTempDir(async (dataDir) => {
    let attempts = 0;
    /** @type {typeof fetch} */
    const fetcher = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('temporary failure');
      }
      return new Response(ICON_BYTES, { status: 200 });
    };

    assert.equal((await getIcon(APPID, { dataDir, fetcher })).path, null);
    assert.deepEqual(
      await getIcon(APPID, { dataDir, fetcher }),
      { path: iconPath(dataDir), cached: false },
    );
    assert.deepEqual(
      await getIcon(APPID, { dataDir, fetcher }),
      { path: iconPath(dataDir), cached: true },
    );
    assert.equal(attempts, 2);
  });
});

test('an HTTP error response is treated as a download failure', async () => {
  await withTempDir(async (dataDir) => {
    /** @type {typeof fetch} */
    const fetcher = async () => new Response('missing', { status: 404 });

    const result = await getIcon(APPID, { dataDir, fetcher });

    assert.equal(result.path, null);
    assert.match(result.error.message, /HTTP 404/);
    assert.deepEqual(await listIconFiles(dataDir), []);
  });
});

test('a download that exceeds the timeout resolves with an error', async () => {
  await withTempDir(async (dataDir) => {
    /** @type {typeof fetch} */
    const fetcher = (input, options = {}) => new Promise((resolve, reject) => {
      const { signal } = /** @type {{ signal?: AbortSignal }} */ (options);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });

    const started = Date.now();
    const result = await getIcon(APPID, { dataDir, fetcher, timeoutMs: 25 });
    const elapsed = Date.now() - started;

    assert.equal(result.path, null);
    assert.ok(result.error instanceof Error);
    assert.ok(elapsed >= 20, `timed out too early after ${elapsed}ms`);
    assert.deepEqual(await listIconFiles(dataDir), []);
  });
});

test('an invalid appid is rejected before touching the filesystem', async () => {
  await withTempDir(async (dataDir) => {
    await assert.rejects(getIcon('413150', { dataDir }), TypeError);
    await assert.rejects(getIcon(-1, { dataDir }), TypeError);
    assert.deepEqual(await readdir(dataDir), []);
  });
});

test('the default data directory comes from WARMER_DATA_DIR', async () => {
  await withTempDir(async (dataDir) => {
    const script = [
      "import { getIcon } from './src/library/icons.js';",
      'const fetcher = async () => new Response(new Uint8Array([1, 2, 3]));',
      `process.stdout.write(JSON.stringify(await getIcon(${APPID}, { fetcher })));`,
    ].join('\n');

    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      {
        cwd: repoRoot,
        env: { ...process.env, WARMER_DATA_DIR: dataDir },
      },
    );

    const result = JSON.parse(stdout);
    assert.deepEqual(result, { path: iconPath(dataDir), cached: false });
    assert.deepEqual(await readFile(iconPath(dataDir)), Buffer.from([1, 2, 3]));
  });
});
