import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectChunks, collectDepots } from '../src/providers/steam/manifest.js';

// The lib tests never talk to Steam: `steam-user` is only reached through the
// injected parser, so this buffer is an opaque stand-in for a real manifest.
const RAW_MANIFEST = Buffer.from('opaque-manifest-bytes');

/**
 * appinfo shaped like the payload inside `getProductInfo().apps[appId].appinfo`.
 *
 * It deliberately mixes numeric depot ids with non-depot keys (`branches`,
 * `baselanguages`) and covers every oslist case the selection must handle:
 * windows only, linux only, no oslist, empty oslist and a shared list.
 *
 * @returns {object}
 */
function createAppInfo() {
  return {
    depots: {
      branches: { public: { buildid: '9000' } },
      baselanguages: 'english',
      44100: {
        config: { oslist: 'windows' },
        manifests: { public: { gid: '1001', size: 100 } },
      },
      44101: {
        config: { oslist: 'linux' },
        manifests: { public: { gid: '1002', size: 200 } },
      },
      44102: {
        manifests: { public: { gid: '1003', size: 300 } },
      },
      44103: {
        config: { oslist: '' },
        manifests: { public: { gid: '1004', size: 400 } },
      },
      44104: {
        config: { oslist: 'windows,linux' },
        manifests: { public: { gid: '1005', size: 500 } },
      },
      44105: {
        config: { oslist: 'windows,macos' },
        manifests: { public: { gid: '1006', size: 600 } },
      },
      44106: {
        manifests: { beta: { gid: '1007', size: 700 } },
      },
      44107: {
        config: { oslist: [] },
        manifests: { public: { gid: '1008', size: 800 } },
      },
    },
  };
}

/**
 * Build a fake `steam-user` that records every `getRawManifest` call.
 *
 * @param {() => Promise<{ manifest: Buffer }>} respond
 * @returns {{ calls: unknown[][], user: { getRawManifest: (...args: unknown[]) => Promise<{ manifest: Buffer }> } }}
 */
function createFakeUser(respond) {
  /** @type {unknown[][]} */
  const calls = [];

  return {
    calls,
    user: {
      getRawManifest: async (...args) => {
        calls.push(args);
        return respond();
      },
    },
  };
}

/**
 * A parsed manifest with duplicate chunks across files, mirroring how Steam
 * references the same chunk from several files.
 *
 * @returns {object}
 */
function createParsedManifest() {
  return {
    files: [
      {
        filename: 'game.exe',
        chunks: [
          { sha: 'a'.repeat(40), cb_original: 100, cb_compressed: 40 },
          { sha: 'b'.repeat(40), cb_original: 200, cb_compressed: 80 },
        ],
      },
      {
        filename: 'data.bin',
        chunks: [
          { sha: 'a'.repeat(40), cb_original: 100, cb_compressed: 40 },
          { sha: 'c'.repeat(40), cb_original: 300, cb_compressed: 120 },
        ],
      },
      { filename: 'empty.txt', chunks: [] },
    ],
  };
}

test('collectDepots keeps the public manifest of every matching depot', () => {
  assert.deepEqual(collectDepots(createAppInfo()), [
    { depotId: 44100, manifestId: '1001', size: 100 },
    { depotId: 44102, manifestId: '1003', size: 300 },
    { depotId: 44103, manifestId: '1004', size: 400 },
    { depotId: 44104, manifestId: '1005', size: 500 },
    { depotId: 44105, manifestId: '1006', size: 600 },
    { depotId: 44107, manifestId: '1008', size: 800 },
  ]);
});

test('collectDepots drops depots without a public manifest and non-depot keys', () => {
  const selected = collectDepots(createAppInfo());

  assert.equal(selected.some((depot) => depot.depotId === 44106), false);
  assert.equal(selected.every((depot) => Number.isSafeInteger(depot.depotId)), true);
});

test('collectDepots filters by opts.osFilter and keeps shared depots', () => {
  assert.deepEqual(collectDepots(createAppInfo(), { osFilter: 'linux' }), [
    { depotId: 44101, manifestId: '1002', size: 200 },
    { depotId: 44102, manifestId: '1003', size: 300 },
    { depotId: 44103, manifestId: '1004', size: 400 },
    { depotId: 44104, manifestId: '1005', size: 500 },
    { depotId: 44107, manifestId: '1008', size: 800 },
  ]);
});

test('collectDepots treats an empty or missing oslist as a shared depot', () => {
  const selected = collectDepots(
    { depots: { 1: { config: { oslist: '' }, manifests: { public: { gid: '1', size: 1 } } } } },
    { osFilter: 'linux' },
  );
  assert.deepEqual(selected, [{ depotId: 1, manifestId: '1', size: 1 }]);

  const noConfig = collectDepots(
    { depots: { 2: { manifests: { public: { gid: '2', size: 2 } } } } },
    { osFilter: 'linux' },
  );
  assert.deepEqual(noConfig, [{ depotId: 2, manifestId: '2', size: 2 }]);
});

test('collectDepots returns an empty list without appinfo depots', () => {
  assert.deepEqual(collectDepots({}), []);
  assert.deepEqual(collectDepots({ depots: { branches: { public: {} } } }), []);
});

test('collectChunks fetches the public manifest and flattens unique chunks', async () => {
  const { calls, user } = createFakeUser(async () => ({ manifest: RAW_MANIFEST }));
  let parsedInput;

  const chunks = await collectChunks(
    user,
    413150,
    { depotId: 44100, manifestId: '1001' },
    {
      parseManifest: (manifest) => {
        parsedInput = manifest;
        return createParsedManifest();
      },
    },
  );

  assert.deepEqual(calls, [[413150, 44100, '1001', 'public']]);
  assert.equal(parsedInput, RAW_MANIFEST);
  assert.deepEqual(chunks, [
    { sha: 'a'.repeat(40), size: 40 },
    { sha: 'b'.repeat(40), size: 80 },
    { sha: 'c'.repeat(40), size: 120 },
  ]);
});

test('collectChunks deduplicates chunks referenced by several files', async () => {
  const { user } = createFakeUser(async () => ({ manifest: RAW_MANIFEST }));

  const chunks = await collectChunks(
    user,
    413150,
    { depotId: 44100, manifestId: '1001' },
    { parseManifest: () => createParsedManifest() },
  );

  assert.equal(chunks.length, 3);
  assert.equal(new Set(chunks.map((chunk) => chunk.sha)).size, 3);
});

test('collectChunks retries a failed manifest fetch and succeeds', async () => {
  let attempts = 0;
  const { calls, user } = createFakeUser(async () => {
    attempts += 1;
    if (attempts <= 2) {
      throw new Error('ECONNRESET');
    }
    return { manifest: RAW_MANIFEST };
  });

  const chunks = await collectChunks(
    user,
    413150,
    { depotId: 44100, manifestId: '1001' },
    { parseManifest: () => createParsedManifest() },
  );

  assert.equal(attempts, 3);
  assert.equal(calls.length, 3);
  assert.equal(chunks.length, 3);
});

test('collectChunks fails after two retries and names the depot', async () => {
  let attempts = 0;
  const { user } = createFakeUser(async () => {
    attempts += 1;
    throw new Error('manifest unavailable');
  });

  await assert.rejects(
    () => collectChunks(
      user,
      413150,
      { depotId: 44100, manifestId: '1001' },
      { parseManifest: () => createParsedManifest() },
    ),
    (error) => {
      assert.match(error.message, /depot 44100/);
      assert.match(error.message, /manifest unavailable/);
      assert.equal(error.cause?.message, 'manifest unavailable');
      return true;
    },
  );
  assert.equal(attempts, 3);
});

test('collectChunks names the depot when the manifest cannot be parsed', async () => {
  const { calls, user } = createFakeUser(async () => ({ manifest: RAW_MANIFEST }));

  await assert.rejects(
    () => collectChunks(
      user,
      413150,
      { depotId: 44100, manifestId: '1001' },
      {
        parseManifest: () => {
          throw new Error('bad manifest');
        },
      },
    ),
    (error) => {
      assert.match(error.message, /depot 44100/);
      assert.match(error.message, /bad manifest/);
      return true;
    },
  );
  // The request succeeded, so a parse failure is not retried.
  assert.equal(calls.length, 1);
});
