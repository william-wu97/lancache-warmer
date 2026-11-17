import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prefillApp } from '../src/providers/steam/prefill.js';

const APP_ID = 413150;
const HOSTS = [
  'cache1-tyo3.steamcontent.com',
  'cache2-tyo3.steamcontent.com',
  'cache3-tyo3.steamcontent.com',
];

/**
 * One manifest chunk entry. `collectChunks` reads `cb_compressed`, which is the
 * number of bytes a download transfers.
 *
 * @param {string} letter
 * @param {number} size
 * @returns {{ sha: string, cb_original: number, cb_compressed: number }}
 */
function chunk(letter, size) {
  return { sha: letter.repeat(40), cb_original: size * 2, cb_compressed: size };
}

/**
 * appinfo with two windows depots (one shared with linux), one linux-only
 * depot, and a depot that has no public manifest.
 *
 * @returns {object}
 */
function createAppInfo() {
  return {
    depots: {
      branches: { public: { buildid: '9000' } },
      44100: {
        config: { oslist: 'windows' },
        manifests: { public: { gid: '1001', size: 100 } },
      },
      44101: {
        config: { oslist: 'windows,linux' },
        manifests: { public: { gid: '1002', size: 200 } },
      },
      44102: {
        config: { oslist: 'linux' },
        manifests: { public: { gid: '1003', size: 300 } },
      },
      44103: {
        config: { oslist: 'windows' },
        manifests: { beta: { gid: '1004', size: 400 } },
      },
    },
  };
}

/**
 * Chunk lists keyed by depot id. The windows-default selection (44100, 44101)
 * has six chunks and 75 compressed bytes in total.
 *
 * @returns {Record<number, object[]>}
 */
function createChunks() {
  return {
    44100: [chunk('a', 10), chunk('b', 11), chunk('c', 12)],
    44101: [chunk('d', 13), chunk('e', 14), chunk('f', 15)],
    44102: [chunk('1', 20), chunk('2', 21)],
  };
}

/**
 * Fake `steam-user` whose appinfo and raw manifests are served locally.
 *
 * The raw manifest is a JSON chunk list so the injected parser can decode it
 * without the real binary format; `getRawManifest` calls are recorded to prove
 * the per-depot order.
 *
 * @param {{
 *   appInfo?: object | null,
 *   chunks?: Record<number, object[]>,
 *   onGetProductInfo?: () => unknown,
 * }} [options]
 * @returns {{
 *   user: object,
 *   productCalls: unknown[][],
 *   manifestCalls: unknown[][],
 * }}
 */
function createFakeUser({ appInfo = createAppInfo(), chunks = createChunks(), onGetProductInfo } = {}) {
  /** @type {unknown[][]} */
  const productCalls = [];
  /** @type {unknown[][]} */
  const manifestCalls = [];

  const user = {
    async getProductInfo(appIds, packageIds) {
      productCalls.push([appIds, packageIds]);
      if (onGetProductInfo) {
        return onGetProductInfo();
      }
      return { apps: { [APP_ID]: { appinfo: appInfo } }, packages: {} };
    },
    async getRawManifest(appId, depotId, manifestId, branch) {
      manifestCalls.push([appId, depotId, manifestId, branch]);
      return { manifest: Buffer.from(JSON.stringify(chunks[depotId] ?? [])) };
    },
  };

  return { user, productCalls, manifestCalls };
}

/**
 * Parser for the fake raw manifest. The real parser is never loaded, so tests
 * stay independent of `steam-user`'s binary manifest component.
 *
 * @param {Buffer} manifest
 * @returns {{ files: { chunks: object[] }[] }}
 */
function parseManifest(manifest) {
  return { files: [{ chunks: JSON.parse(manifest.toString('utf8')) }] };
}

/**
 * Downloader double that records every call. The handler may reject to
 * simulate a host failure.
 *
 * @param {(call: { host: string, depotId: number, sha: string, size: number }, index: number) => unknown} handler
 * @returns {{
 *   calls: { host: string, depotId: number, sha: string, size: number }[],
 *   download: Function,
 * }}
 */
function createDownloader(handler) {
  /**
   * @type {{ host: string, depotId: number, sha: string, size: number }[]}
   */
  const calls = [];

  const download = async (host, depotId, sha, size) => {
    const call = { host, depotId, sha, size };
    calls.push(call);

    const result = await handler(call, calls.length);
    if (!result) {
      return { bytes: 0, cacheStatus: null };
    }
    return result;
  };

  return { calls, download };
}

test('prefillApp resolves appinfo, collects every depot and downloads every chunk', async () => {
  const { user, productCalls, manifestCalls } = createFakeUser();
  const progress = [];
  const { calls, download } = createDownloader(({ size }, index) => ({
    bytes: size,
    cacheStatus: index % 2 === 0 ? 'HIT' : 'MISS',
  }));

  const result = await prefillApp(user, APP_ID, {
    hosts: HOSTS,
    concurrency: 2,
    downloadChunk: download,
    parseManifest,
    onProgress: (update) => progress.push(update),
  });

  assert.deepEqual(result, {
    appId: APP_ID,
    depots: 2,
    chunks: 6,
    bytes: 75,
    hit: 3,
    miss: 3,
    failed: 0,
  });

  // appinfo is requested for the one app, then each selected depot's public
  // manifest is fetched exactly once, in depot order.
  assert.deepEqual(productCalls, [[[APP_ID], []]]);
  assert.deepEqual(manifestCalls, [
    [APP_ID, 44100, '1001', 'public'],
    [APP_ID, 44101, '1002', 'public'],
  ]);

  // Every chunk of both depots was downloaded once, with its depot id and
  // compressed size.
  const expected = [
    [44100, 'a'.repeat(40), 10],
    [44100, 'b'.repeat(40), 11],
    [44100, 'c'.repeat(40), 12],
    [44101, 'd'.repeat(40), 13],
    [44101, 'e'.repeat(40), 14],
    [44101, 'f'.repeat(40), 15],
  ];
  assert.deepEqual(
    calls.map(({ depotId, sha, size }) => [depotId, sha, size]).sort(),
    expected.sort(),
  );

  // Hosts rotate instead of all traffic going to one CDN node.
  assert.equal(new Set(calls.map(({ host }) => host)).size, HOSTS.length);
  for (let index = 1; index < calls.length; index += 1) {
    assert.notEqual(calls[index].host, calls[index - 1].host);
  }

  // Progress is cumulative and its final values match the returned summary.
  assert.equal(progress.length, 6);
  assert.deepEqual(progress.at(-1), {
    chunksOk: 6,
    chunksFailed: 0,
    bytes: 75,
    hit: 3,
    miss: 3,
  });
});

test('prefillApp retries a failing chunk on other hosts and keeps the rest moving', async () => {
  const { user } = createFakeUser();
  const failingSha = 'b'.repeat(40);
  const { calls, download } = createDownloader(({ sha, size }) => {
    if (sha === failingSha) {
      throw new Error('host returned HTTP 503');
    }
    return { bytes: size, cacheStatus: 'HIT' };
  });
  const progress = [];

  const result = await prefillApp(user, APP_ID, {
    hosts: HOSTS,
    concurrency: 1,
    downloadChunk: download,
    parseManifest,
    onProgress: (update) => progress.push(update),
  });

  const failedCalls = calls.filter(({ sha }) => sha === failingSha);
  assert.equal(failedCalls.length, 3);
  // The rotation had already used the first host for the preceding chunk, so
  // the three attempts continue from the next host and wrap around.
  assert.deepEqual(failedCalls.map(({ host }) => host), [HOSTS[1], HOSTS[2], HOSTS[0]]);
  assert.equal(new Set(failedCalls.map(({ host }) => host)).size, 3);

  // The failure is counted, not thrown; remaining chunks still download.
  assert.deepEqual(result, {
    appId: APP_ID,
    depots: 2,
    chunks: 6,
    bytes: 75 - 11,
    hit: 5,
    miss: 0,
    failed: 1,
  });
  assert.equal(calls.length, 8);
  assert.deepEqual(progress.at(-1), {
    chunksOk: 5,
    chunksFailed: 1,
    bytes: 64,
    hit: 5,
    miss: 0,
  });
});

test('prefillApp succeeds when a retry on another host works', async () => {
  const { user } = createFakeUser();
  const flakySha = 'a'.repeat(40);
  let flakyAttempts = 0;

  const { calls, download } = createDownloader(({ sha, size }) => {
    if (sha === flakySha) {
      flakyAttempts += 1;
      if (flakyAttempts <= 2) {
        throw new Error('transient host failure');
      }
    }
    return { bytes: size, cacheStatus: 'MISS' };
  });

  const result = await prefillApp(user, APP_ID, {
    hosts: HOSTS,
    concurrency: 1,
    downloadChunk: download,
    parseManifest,
  });

  const flakyCalls = calls.filter(({ sha }) => sha === flakySha);
  assert.equal(flakyCalls.length, 3);
  assert.deepEqual(flakyCalls.map(({ host }) => host), HOSTS);
  assert.equal(calls.length, 8);
  assert.deepEqual(result, {
    appId: APP_ID,
    depots: 2,
    chunks: 6,
    bytes: 75,
    hit: 0,
    miss: 6,
    failed: 0,
  });
});

test('prefillApp stops dispatching new chunks when shouldStop returns true', async () => {
  const { user } = createFakeUser();
  let stop = false;
  const { calls, download } = createDownloader(({ size }, index) => {
    if (index === 2) {
      stop = true;
    }
    return { bytes: size, cacheStatus: 'HIT' };
  });

  const result = await prefillApp(user, APP_ID, {
    hosts: HOSTS,
    concurrency: 1,
    downloadChunk: download,
    parseManifest,
    shouldStop: () => stop,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(result, {
    appId: APP_ID,
    depots: 2,
    chunks: 6,
    bytes: 21,
    hit: 2,
    miss: 0,
    failed: 0,
  });
});

test('prefillApp dispatches nothing when shouldStop is already true', async () => {
  const { user } = createFakeUser();
  const { calls, download } = createDownloader(() => ({ bytes: 0, cacheStatus: null }));

  const result = await prefillApp(user, APP_ID, {
    hosts: HOSTS,
    downloadChunk: download,
    parseManifest,
    shouldStop: () => true,
  });

  assert.equal(calls.length, 0);
  assert.deepEqual(result, {
    appId: APP_ID,
    depots: 2,
    chunks: 6,
    bytes: 0,
    hit: 0,
    miss: 0,
    failed: 0,
  });
});

test('prefillApp rejects with the app id when no depot is usable', async () => {
  const { user } = createFakeUser({
    appInfo: {
      depots: {
        44102: {
          config: { oslist: 'linux' },
          manifests: { public: { gid: '1003', size: 300 } },
        },
      },
    },
  });
  const { calls, download } = createDownloader(() => {
    throw new Error('must not download');
  });

  await assert.rejects(
    () => prefillApp(user, APP_ID, { downloadChunk: download, parseManifest }),
    (error) => {
      assert.match(error.message, /No downloadable depots/);
      assert.match(error.message, new RegExp(String(APP_ID)));
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('prefillApp rejects with the app id when appinfo cannot be resolved', async () => {
  const { user } = createFakeUser({ onGetProductInfo: () => ({ apps: {}, packages: {} }) });

  await assert.rejects(
    () => prefillApp(user, APP_ID, { hosts: HOSTS }),
    new RegExp(String(APP_ID)),
  );
});

test('prefillApp honours opts.osFilter when selecting depots', async () => {
  const { user, manifestCalls } = createFakeUser();
  const { download } = createDownloader(({ size }) => ({ bytes: size, cacheStatus: null }));

  const result = await prefillApp(user, APP_ID, {
    hosts: HOSTS,
    osFilter: 'linux',
    downloadChunk: download,
    parseManifest,
  });

  assert.deepEqual(manifestCalls, [
    [APP_ID, 44101, '1002', 'public'],
    [APP_ID, 44102, '1003', 'public'],
  ]);
  assert.equal(result.depots, 2);
  assert.equal(result.chunks, 5);
  assert.equal(result.bytes, 83);
});

test('prefillApp uses the default concurrency when none is given', async () => {
  const chunks = Array.from(
    { length: 20 },
    (_, index) => chunk(String.fromCharCode('a'.charCodeAt(0) + index), index + 1),
  );
  const { user } = createFakeUser({
    appInfo: {
      depots: {
        44100: {
          config: { oslist: 'windows' },
          manifests: { public: { gid: '1001', size: 100 } },
        },
      },
    },
    chunks: { 44100: chunks },
  });

  let active = 0;
  let peak = 0;
  const { download } = createDownloader(async ({ size }) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { bytes: size, cacheStatus: 'HIT' };
  });

  const result = await prefillApp(user, APP_ID, {
    hosts: HOSTS,
    downloadChunk: download,
    parseManifest,
  });

  assert.equal(result.chunks, 20);
  assert.equal(result.failed, 0);
  // 默认并发已提到 32（CONCURRENCY 可覆盖）：20 个 chunk 应全部并行
  assert.equal(peak, 20);
});

test('a throwing onProgress callback cannot abort or retry downloads', async () => {
  const { user } = createFakeUser();
  const { calls, download } = createDownloader(({ size }) => ({ bytes: size, cacheStatus: 'HIT' }));

  const result = await prefillApp(user, APP_ID, {
    hosts: HOSTS,
    downloadChunk: download,
    parseManifest,
    onProgress: () => {
      throw new Error('progress UI failed');
    },
  });

  assert.equal(calls.length, 6);
  assert.equal(result.failed, 0);
  assert.equal(result.bytes, 75);
});

test('prefillApp validates its inputs', async () => {
  const { user } = createFakeUser();
  const download = async () => ({ bytes: 0, cacheStatus: null });

  await assert.rejects(() => prefillApp(user, 0, { hosts: HOSTS }), /appId/);
  await assert.rejects(() => prefillApp({}, APP_ID, { hosts: HOSTS }), /getProductInfo/);
  await assert.rejects(
    () => prefillApp(user, APP_ID, { hosts: HOSTS, downloadChunk: download, concurrency: 0 }),
    /concurrency/,
  );
  await assert.rejects(
    () => prefillApp(user, APP_ID, { hosts: HOSTS, downloadChunk: download, shouldStop: 'yes' }),
    /shouldStop/,
  );
});
