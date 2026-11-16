import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { clearToken, loadToken, saveToken } from '../src/providers/steam/token-store.js';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

// Fake credential values: shaped like the real records but not usable tokens.
const REFRESH_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.fake-refresh-token';
const OTHER_REFRESH_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.other-fake-refresh-token';
const STEAM_ID = '76561198000000000';
const SAVED_AT = 1700000000;

/**
 * Run a test against a fresh temporary data directory and always clean it up.
 *
 * @template T
 * @param {(dataDir: string) => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withTempDir(run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lancache-warmer-token-'));
  try {
    return await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
function tokenFilePath(dataDir) {
  return path.join(dataDir, 'steam-token.json');
}

/**
 * @param {string} dataDir
 * @returns {Promise<number>}
 */
async function tokenFileMode(dataDir) {
  const stats = await stat(tokenFilePath(dataDir));
  return stats.mode & 0o777;
}

test('a missing token file loads as null and is not created', async () => {
  await withTempDir(async (dataDir) => {
    const missingDir = path.join(dataDir, 'missing');

    assert.equal(await loadToken({ dataDir: missingDir }), null);
    await assert.rejects(stat(missingDir), { code: 'ENOENT' });
  });
});

test('saveToken stores a token that loadToken reads back from a new directory', async () => {
  await withTempDir(async (dataDir) => {
    const nestedDir = path.join(dataDir, 'steam', 'nested');
    const token = {
      refreshToken: REFRESH_TOKEN,
      savedAt: SAVED_AT,
      steamId: STEAM_ID,
    };

    await saveToken(token, { dataDir: nestedDir });

    assert.deepEqual(await loadToken({ dataDir: nestedDir }), token);
    assert.deepEqual(JSON.parse(await readFile(tokenFilePath(nestedDir), 'utf8')), token);
  });
});

test('the token file is created with mode 600', async () => {
  await withTempDir(async (dataDir) => {
    await saveToken(
      { refreshToken: REFRESH_TOKEN, savedAt: SAVED_AT, steamId: STEAM_ID },
      { dataDir },
    );

    assert.equal(await tokenFileMode(dataDir), 0o600);
  });
});

test('overwriting a token keeps mode 600 and leaves no temporary file behind', async () => {
  await withTempDir(async (dataDir) => {
    // An existing world-readable file must not stay readable after a resave.
    await writeFile(tokenFilePath(dataDir), '{"refreshToken":"old"}\n', { mode: 0o644 });

    await saveToken(
      { refreshToken: OTHER_REFRESH_TOKEN, savedAt: SAVED_AT, steamId: STEAM_ID },
      { dataDir },
    );

    assert.equal(await tokenFileMode(dataDir), 0o600);
    assert.deepEqual(await readdir(dataDir), ['steam-token.json']);

    const token = await loadToken({ dataDir });
    assert.equal(token?.refreshToken, OTHER_REFRESH_TOKEN);
  });
});

test('saveToken rejects an incomplete or invalid record without writing', async () => {
  await withTempDir(async (dataDir) => {
    const invalid = [
      undefined,
      null,
      [],
      {},
      { refreshToken: '' },
      { refreshToken: '   ' },
      { refreshToken: 42 },
      { refreshToken: null },
      { refreshToken: REFRESH_TOKEN, steamId: STEAM_ID },
      { refreshToken: REFRESH_TOKEN, savedAt: SAVED_AT },
      { refreshToken: REFRESH_TOKEN, savedAt: '1700000000', steamId: STEAM_ID },
      { refreshToken: REFRESH_TOKEN, savedAt: -1, steamId: STEAM_ID },
      { refreshToken: REFRESH_TOKEN, savedAt: 1.5, steamId: STEAM_ID },
      { refreshToken: REFRESH_TOKEN, savedAt: SAVED_AT, steamId: 76561198000000000 },
    ];

    for (const data of invalid) {
      await assert.rejects(saveToken(data, { dataDir }), TypeError);
    }

    // A failed save must not leave a token or a temporary file behind.
    assert.deepEqual(await readdir(dataDir), []);
  });
});

test('a damaged token file loads as null instead of throwing', async () => {
  await withTempDir(async (dataDir) => {
    const damaged = [
      'not json at all',
      '',
      '{"refreshToken":',
      'null',
      '[]',
      '"just a string"',
      '{}',
      JSON.stringify({ refreshToken: '' }),
      JSON.stringify({ refreshToken: '   ' }),
      JSON.stringify({ refreshToken: 42 }),
      // A valid credential is not enough: the documented metadata must be there.
      JSON.stringify({ refreshToken: REFRESH_TOKEN }),
      JSON.stringify({ refreshToken: REFRESH_TOKEN, savedAt: SAVED_AT }),
      JSON.stringify({ refreshToken: REFRESH_TOKEN, steamId: STEAM_ID }),
      JSON.stringify({ refreshToken: REFRESH_TOKEN, savedAt: '1700000000', steamId: STEAM_ID }),
      JSON.stringify({ refreshToken: REFRESH_TOKEN, savedAt: SAVED_AT, steamId: 76561198000000000 }),
      JSON.stringify({ savedAt: SAVED_AT, steamId: STEAM_ID }),
    ];

    for (const contents of damaged) {
      await writeFile(tokenFilePath(dataDir), contents);
      assert.equal(await loadToken({ dataDir }), null, `contents: ${contents}`);
    }
  });
});

test('saveToken error messages never include the token value', async () => {
  await withTempDir(async (dataDir) => {
    await assert.rejects(
      saveToken({ refreshToken: REFRESH_TOKEN, savedAt: SAVED_AT }, { dataDir }),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.ok(!error.message.includes(REFRESH_TOKEN), 'error message leaks the token');
        return true;
      },
    );

    assert.deepEqual(await readdir(dataDir), []);
  });
});

test('the default data directory comes from WARMER_DATA_DIR', async () => {
  await withTempDir(async (dataDir) => {
    const token = { refreshToken: REFRESH_TOKEN, savedAt: SAVED_AT, steamId: STEAM_ID };
    const script = [
      "import { loadToken, saveToken } from './src/providers/steam/token-store.js';",
      `await saveToken(${JSON.stringify(token)});`,
      'process.stdout.write(JSON.stringify(await loadToken()));',
    ].join('\n');

    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      {
        cwd: repoRoot,
        env: { ...process.env, WARMER_DATA_DIR: dataDir },
      },
    );

    assert.deepEqual(JSON.parse(stdout), token);
    assert.deepEqual(JSON.parse(await readFile(tokenFilePath(dataDir), 'utf8')), token);
    assert.equal(await tokenFileMode(dataDir), 0o600);
  });
});

test('clearToken removes the file and is a no-op when nothing is stored', async () => {
  await withTempDir(async (dataDir) => {
    await saveToken(
      { refreshToken: REFRESH_TOKEN, savedAt: SAVED_AT, steamId: STEAM_ID },
      { dataDir },
    );

    await clearToken({ dataDir });
    assert.equal(await loadToken({ dataDir }), null);
    await assert.rejects(stat(tokenFilePath(dataDir)), { code: 'ENOENT' });

    // Clearing again must not reject.
    await clearToken({ dataDir });
    assert.equal(await loadToken({ dataDir }), null);
  });
});
