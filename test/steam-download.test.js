import assert from 'node:assert/strict';
import { test } from 'node:test';

import { downloadChunk, pickHosts, runPool } from '../src/providers/steam/download.js';

const HOST = 'cache7-tyo3.steamcontent.com';
const DEPOT_ID = 413151;
const SHA = 'a'.repeat(40);
const USER_AGENT = 'Valve/Steam HTTP Client 1.0';

/**
 * Build a fake response whose body yields `parts` and then closes.
 *
 * @param {Uint8Array[]} parts
 * @param {{ status?: number, headers?: Record<string, string> }} [init]
 * @returns {Response}
 */
function streamResponse(parts, { status = 200, headers = {} } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });

  return new Response(body, { status, headers });
}

test('downloadChunk builds the chunk URL, sends the Steam UA and counts streamed bytes', async () => {
  /** @type {{ url: string, init: RequestInit }[]} */
  const requests = [];

  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return streamResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])], {
      headers: { 'x-cache-status': 'HIT' },
    });
  };

  const result = await downloadChunk(HOST, DEPOT_ID, SHA, 7, { fetcher });

  assert.deepEqual(result, { bytes: 7, cacheStatus: 'HIT' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `http://${HOST}/depot/${DEPOT_ID}/chunk/${SHA}`);
  assert.equal(requests[0].init.headers['User-Agent'], USER_AGENT);
  // The response body is consumed as a stream, never returned or buffered.
  assert.deepEqual(Object.keys(result).sort(), ['bytes', 'cacheStatus']);
});

test('downloadChunk parses x-cache-status and tolerates a missing header', async () => {
  const miss = await downloadChunk(HOST, DEPOT_ID, SHA, 1, {
    fetcher: async () => streamResponse([new Uint8Array([1])], {
      headers: { 'x-cache-status': 'miss' },
    }),
  });
  assert.deepEqual(miss, { bytes: 1, cacheStatus: 'MISS' });

  const unknown = await downloadChunk(HOST, DEPOT_ID, SHA, 1, {
    fetcher: async () => streamResponse([new Uint8Array([1])], {
      headers: { 'x-cache-status': 'BYPASS' },
    }),
  });
  assert.deepEqual(unknown, { bytes: 1, cacheStatus: null });

  const absent = await downloadChunk(HOST, DEPOT_ID, SHA, 1, {
    fetcher: async () => streamResponse([new Uint8Array([1])]),
  });
  assert.deepEqual(absent, { bytes: 1, cacheStatus: null });
});

test('downloadChunk rejects a truncated body but tolerates extra bytes', async () => {
  // 少于预期：数据被截断，必须报错
  await assert.rejects(
    () => downloadChunk(HOST, DEPOT_ID, SHA, 10, {
      fetcher: async () => streamResponse([new Uint8Array(4)]),
    }),
    (error) => {
      assert.match(error.message, /truncated/);
      assert.match(error.message, /at least 10 bytes, got 4/);
      return true;
    },
  );

  // 多于预期：expectedSize 是「压缩后」大小，国内 CDN 返回解压后的内容会更大，
  // 这是正常的，不能当失败处理。
  const result = await downloadChunk(HOST, DEPOT_ID, SHA, 2, {
    fetcher: async () => streamResponse([new Uint8Array(3)]),
  });
  assert.equal(result.bytes, 3);
});

test('downloadChunk rejects a non-2xx response', async () => {
  await assert.rejects(
    () => downloadChunk(HOST, DEPOT_ID, SHA, 0, {
      fetcher: async () => new Response('nope', { status: 503 }),
    }),
    /failed with HTTP 503/,
  );
});

test('downloadChunk aborts and rejects when the timeout expires', async () => {
  let abortSignal;

  const fetcher = (url, init) => {
    abortSignal = init.signal;
    // Keep the request pending forever; the pool-ish race must still reject.
    return new Promise(() => {});
  };

  await assert.rejects(
    () => downloadChunk(HOST, DEPOT_ID, SHA, 1, { fetcher, timeoutMs: 20 }),
    /timed out after 20ms/,
  );

  assert.equal(abortSignal instanceof AbortSignal, true);
  assert.equal(abortSignal.aborted, true);
});

test('downloadChunk validates its inputs', async () => {
  const fetcher = async () => streamResponse([new Uint8Array(0)]);

  await assert.rejects(() => downloadChunk('', DEPOT_ID, SHA, 0, { fetcher }), /host/);
  await assert.rejects(() => downloadChunk(HOST, DEPOT_ID, '', 0, { fetcher }), /sha/);
  await assert.rejects(() => downloadChunk(HOST, DEPOT_ID, SHA, -1, { fetcher }), /expectedSize/);
  await assert.rejects(
    () => downloadChunk(HOST, DEPOT_ID, SHA, 0, { fetcher, timeoutMs: 0 }),
    /timeoutMs/,
  );
});

test('runPool never exceeds the configured concurrency', async () => {
  const items = Array.from({ length: 12 }, (_, index) => index);

  let active = 0;
  let peak = 0;
  const processed = [];

  const result = await runPool(items, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    processed.push(item);
    active -= 1;
  }, 3);

  assert.equal(peak, 3);
  assert.deepEqual([...processed].sort((left, right) => left - right), items);
  assert.deepEqual(result, {
    total: 12,
    started: 12,
    succeeded: 12,
    failed: 0,
    stopped: false,
  });
});

test('runPool counts failed tasks and keeps running the rest', async () => {
  const items = [0, 1, 2, 3, 4];
  const completed = [];

  const result = await runPool(items, async (item) => {
    if (item % 2 === 0) {
      throw new Error(`chunk ${item} failed`);
    }
    completed.push(item);
  }, 2);

  assert.deepEqual(completed.sort((left, right) => left - right), [1, 3]);
  assert.deepEqual(result, {
    total: 5,
    started: 5,
    succeeded: 2,
    failed: 3,
    stopped: false,
  });
});

test('runPool stops dispatching when shouldStop becomes true', async () => {
  let stop = false;
  const started = [];

  const result = await runPool([1, 2, 3, 4, 5, 6], async (item) => {
    started.push(item);
    if (started.length === 2) {
      stop = true;
    }
  }, 1, { shouldStop: () => stop });

  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(result, {
    total: 6,
    started: 2,
    succeeded: 2,
    failed: 0,
    stopped: true,
  });
});

test('runPool starts nothing when shouldStop is already true', async () => {
  let calls = 0;

  const result = await runPool([1, 2, 3], async () => {
    calls += 1;
  }, 2, { shouldStop: () => true });

  assert.equal(calls, 0);
  assert.deepEqual(result, {
    total: 3,
    started: 0,
    succeeded: 0,
    failed: 0,
    stopped: true,
  });
});

test('runPool rejects an invalid concurrency', async () => {
  await assert.rejects(() => runPool([1], async () => {}, 0), /concurrency/);
  await assert.rejects(() => runPool([1], async () => {}, 1.5), /concurrency/);
});

test('pickHosts keeps only steamcontent.com cache nodes', () => {
  assert.deepEqual(
    pickHosts([
      'cache7-tyo3.steamcontent.com',
      'cloudflare.steamstatic.com',
      'cache1-sgp1.steamcontent.com',
      'notsteamcontent.com',
      'steamcontent.com.evil.com',
      'cache2-tyo3.steamcontent.com',
    ]),
    [
      'cache7-tyo3.steamcontent.com',
      'cache1-sgp1.steamcontent.com',
      'cache2-tyo3.steamcontent.com',
    ],
  );
});

test('pickHosts accepts server objects and host-keyed maps', () => {
  assert.deepEqual(
    pickHosts([
      { host: 'cache3-tyo3.steamcontent.com' },
      { hostname: 'cache4-tyo3.steamcontent.com' },
      { host: 'cloudflare.steamstatic.com' },
      {},
    ]),
    ['cache3-tyo3.steamcontent.com', 'cache4-tyo3.steamcontent.com'],
  );

  assert.deepEqual(
    pickHosts({
      'cache5-tyo3.steamcontent.com': { load: 1 },
      'cloudflare.steamstatic.com': { load: 2 },
    }),
    ['cache5-tyo3.steamcontent.com'],
  );
});

test('pickHosts normalises hosts, strips ports and de-duplicates', () => {
  assert.deepEqual(
    pickHosts([
      'CACHE6-TYO3.STEAMCONTENT.COM:443',
      'http://cache6-tyo3.steamcontent.com/depot/1/chunk/abc',
      'cache6-tyo3.steamcontent.com.',
      'steamcontent.com',
    ]),
    ['cache6-tyo3.steamcontent.com', 'steamcontent.com'],
  );

  assert.deepEqual(pickHosts(null), []);
  assert.deepEqual(pickHosts([]), []);
  assert.deepEqual(pickHosts(['']), []);
});

test('pickHosts supports a custom suffix', () => {
  assert.deepEqual(
    pickHosts(['cache.example.com', 'cloudflare.steamstatic.com'], { suffix: 'example.com' }),
    ['cache.example.com'],
  );
});
