import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { add, list, remove, search } from '../src/library/store.js';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

/**
 * Run a test against a fresh temporary data directory and always clean it up.
 *
 * @template T
 * @param {(dataDir: string) => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withTempDir(run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lancache-warmer-library-'));
  try {
    return await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

/**
 * @param {string} dataDir
 * @returns {Promise<unknown>}
 */
async function readLibraryFile(dataDir) {
  return JSON.parse(await readFile(path.join(dataDir, 'library.json'), 'utf8'));
}

test('an empty or missing library reads as an empty list', async () => {
  await withTempDir(async (dataDir) => {
    assert.deepEqual(await list(dataDir), []);
    assert.deepEqual(await search('anything', dataDir), []);
    assert.equal(await remove(413150, dataDir), false);

    // Reading a missing library must not create the file.
    await assert.rejects(readLibraryFile(dataDir), { code: 'ENOENT' });
  });
});

test('the first add creates the library file and records appid, name and addedAt', async () => {
  await withTempDir(async (dataDir) => {
    const before = Math.floor(Date.now() / 1000);

    assert.deepEqual(await add(413150, 'Stardew Valley', dataDir), { created: true });

    const after = Math.floor(Date.now() / 1000);
    const [item] = await list(dataDir);

    assert.equal(item.appid, 413150);
    assert.equal(item.name, 'Stardew Valley');
    assert.ok(Number.isInteger(item.addedAt));
    assert.ok(item.addedAt >= before && item.addedAt <= after);
    assert.deepEqual(await readLibraryFile(dataDir), { items: [item] });
  });
});

test('adding an existing appid updates its name and preserves addedAt', async () => {
  await withTempDir(async (dataDir) => {
    await add(413150, 'Stardew Valley', dataDir);
    const [original] = await list(dataDir);

    assert.deepEqual(await add(413150, 'Stardew Valley (PC)', dataDir), { created: false });

    const items = await list(dataDir);
    assert.equal(items.length, 1);
    assert.equal(items[0].name, 'Stardew Valley (PC)');
    assert.equal(items[0].addedAt, original.addedAt);
  });
});

test('list returns items sorted by appid ascending regardless of insertion order', async () => {
  await withTempDir(async (dataDir) => {
    await add(730, 'Counter-Strike 2', dataDir);
    await add(413150, 'Stardew Valley', dataDir);
    await add(570, 'Dota 2', dataDir);

    assert.deepEqual(
      (await list(dataDir)).map((item) => item.appid),
      [570, 730, 413150],
    );
  });
});

test('list returns a copy that does not expose the stored array', async () => {
  await withTempDir(async (dataDir) => {
    await add(413150, 'Stardew Valley', dataDir);

    const items = await list(dataDir);
    items.length = 0;

    assert.equal((await list(dataDir)).length, 1);
  });
});

test('remove deletes an existing appid and reports a missing one', async () => {
  await withTempDir(async (dataDir) => {
    await add(413150, 'Stardew Valley', dataDir);
    await add(570, 'Dota 2', dataDir);

    assert.equal(await remove(413150, dataDir), true);
    assert.deepEqual(
      (await list(dataDir)).map((item) => item.appid),
      [570],
    );

    assert.equal(await remove(413150, dataDir), false);
    assert.deepEqual(
      (await list(dataDir)).map((item) => item.appid),
      [570],
    );
  });
});

test('search matches appid substrings and names case-insensitively', async () => {
  await withTempDir(async (dataDir) => {
    await add(413150, 'Stardew Valley', dataDir);
    await add(570, 'Dota 2', dataDir);
    await add(730, 'Counter-Strike 2', dataDir);

    assert.deepEqual(
      (await search('', dataDir)).map((item) => item.appid),
      [570, 730, 413150],
    );
    assert.deepEqual(
      (await search('413', dataDir)).map((item) => item.appid),
      [413150],
    );
    assert.deepEqual(
      (await search('stardew', dataDir)).map((item) => item.appid),
      [413150],
    );
    assert.deepEqual(
      (await search('STRIKE', dataDir)).map((item) => item.appid),
      [730],
    );
    assert.deepEqual(await search('no-such-game', dataDir), []);
  });
});

test('the first write creates a missing nested data directory', async () => {
  await withTempDir(async (root) => {
    const dataDir = path.join(root, 'warmer', 'data');

    await add(413150, 'Stardew Valley', dataDir);

    assert.equal((await list(dataDir)).length, 1);
  });
});

test('concurrent adds are serialised instead of losing updates', async () => {
  await withTempDir(async (dataDir) => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => add(1000 + index, `Game ${index}`, dataDir)),
    );

    const items = await list(dataDir);
    assert.equal(items.length, 20);
    assert.deepEqual(
      items.map((item) => item.appid),
      Array.from({ length: 20 }, (_, index) => 1000 + index),
    );
  });
});

test('writes leave no temporary files behind and keep valid JSON', async () => {
  await withTempDir(async (dataDir) => {
    await add(413150, 'Stardew Valley', dataDir);
    await add(570, 'Dota 2', dataDir);

    assert.deepEqual(await readdir(dataDir), ['library.json']);
    assert.equal((await readLibraryFile(dataDir)).items.length, 2);
  });
});

test('the default data directory comes from WARMER_DATA_DIR', async () => {
  await withTempDir(async (dataDir) => {
    const script = [
      "import { add, list } from './src/library/store.js';",
      "await add(413150, 'Stardew Valley');",
      'process.stdout.write(JSON.stringify(await list()));',
    ].join('\n');

    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      {
        cwd: repoRoot,
        env: { ...process.env, WARMER_DATA_DIR: dataDir },
      },
    );

    const items = JSON.parse(stdout);
    assert.deepEqual(items.map((item) => item.appid), [413150]);
    assert.deepEqual(await readLibraryFile(dataDir), { items });
  });
});
