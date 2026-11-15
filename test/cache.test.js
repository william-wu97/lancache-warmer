import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { scanCache } from '../src/library/cache.js';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

let cacheDir;

before(async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), 'lancache-warmer-cache-'));

  // Layout described in the issue: <cache>/steam/depot_<id>/<shards>.
  await mkdir(path.join(cacheDir, 'steam', 'depot_123'), { recursive: true });
  await mkdir(path.join(cacheDir, 'steam', 'depot_456', 'nested'), { recursive: true });
  await mkdir(path.join(cacheDir, 'steam', 'not-a-depot'), { recursive: true });

  await writeFile(path.join(cacheDir, 'steam', 'depot_123', 'chunk-a.bin'), Buffer.alloc(100));
  await writeFile(path.join(cacheDir, 'steam', 'depot_123', 'chunk-b.bin'), Buffer.alloc(250));
  await writeFile(
    path.join(cacheDir, 'steam', 'depot_456', 'nested', 'chunk-c.bin'),
    Buffer.alloc(1000),
  );

  // Neither of these may contribute to the totals.
  await writeFile(
    path.join(cacheDir, 'steam', 'not-a-depot', 'ignored.bin'),
    Buffer.alloc(5000),
  );
  await writeFile(path.join(cacheDir, 'loose.bin'), Buffer.alloc(4096));
});

after(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

/**
 * Describe a directory tree (paths, types, sizes, mtimes) so tests can prove a
 * scan did not create, delete or rewrite anything.
 *
 * @param {string} dir
 * @returns {Promise<Array<[string, boolean, number, number]>>}
 */
async function snapshotTree(dir) {
  const snapshot = [];

  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const info = await stat(entryPath);
      snapshot.push([
        path.relative(dir, entryPath),
        info.isDirectory(),
        info.size,
        info.mtimeMs,
      ]);
      if (entry.isDirectory()) {
        await walk(entryPath);
      }
    }
  }

  await walk(dir);
  return snapshot.sort(([left], [right]) => left.localeCompare(right));
}

test('scanCache totals bytes, files and depots', async () => {
  const result = await scanCache(cacheDir);

  assert.equal(result.available, true);
  assert.equal(result.bytes, 1350);
  assert.equal(result.files, 3);
  assert.equal(result.gb, 1350 / 1024 ** 3);
  assert.deepEqual(result.depots, {
    123: { bytes: 350, files: 2 },
    456: { bytes: 1000, files: 1 },
  });
});

test('scanCache finds depots in the nested <cache>/cache/steam layout', async () => {
  const nestedRoot = await mkdtemp(path.join(os.tmpdir(), 'lancache-warmer-nested-'));
  try {
    await mkdir(path.join(nestedRoot, 'cache', 'steam', 'depot_789'), { recursive: true });
    await writeFile(
      path.join(nestedRoot, 'cache', 'steam', 'depot_789', 'chunk.bin'),
      Buffer.alloc(2048),
    );

    const result = await scanCache(nestedRoot);

    assert.equal(result.available, true);
    assert.deepEqual(result.depots, { 789: { bytes: 2048, files: 1 } });
  } finally {
    await rm(nestedRoot, { recursive: true, force: true });
  }
});

test('scanCache reports unavailable instead of throwing for a missing directory', async () => {
  const missing = path.join(cacheDir, 'does-not-exist');

  assert.deepEqual(await scanCache(missing), { available: false });
});

test('scanCache reports unavailable when the path is a file', async () => {
  assert.deepEqual(
    await scanCache(path.join(cacheDir, 'loose.bin')),
    { available: false },
  );
});

test('scanCache is read-only', async () => {
  const before = await snapshotTree(cacheDir);

  await scanCache(cacheDir);

  assert.deepEqual(await snapshotTree(cacheDir), before);
});

test('scanCache defaults to the cache directory from config', async () => {
  const script = [
    "import { scanCache } from './src/library/cache.js';",
    'process.stdout.write(JSON.stringify(await scanCache()));',
  ].join('\n');

  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    script,
  ], {
    cwd: repoRoot,
    env: { ...process.env, CACHE_DATA_DIR: cacheDir },
  });

  const result = JSON.parse(stdout);

  assert.equal(result.available, true);
  assert.deepEqual(result.depots, {
    123: { bytes: 350, files: 2 },
    456: { bytes: 1000, files: 1 },
  });
});
