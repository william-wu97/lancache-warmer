import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { NotLoggedInError, TaskConflictError } from '../src/api/task-runner.js';
import { createServer } from '../src/server.js';

/**
 * @returns {object} A fresh idle snapshot.
 */
function idleSnapshot() {
  return {
    state: 'idle',
    appIds: [],
    progress: {
      appsDone: 0,
      appsTotal: 0,
      chunksOk: 0,
      chunksFailed: 0,
      bytes: 0,
      hit: 0,
      miss: 0,
    },
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

/** Mutable behaviour the fake runner exposes to each test. */
const behaviour = {
  start: async () => ({ taskId: 'task-1', state: 'running' }),
  cancel: () => false,
  snapshot: idleSnapshot(),
  logs: [],
};

/** @type {Set<(entry: object) => void>} */
const subscribers = new Set();
let unsubscribeCount = 0;

const fakeRunner = {
  start: (appIds) => behaviour.start(appIds),
  getSnapshot: () => behaviour.snapshot,
  cancel: () => behaviour.cancel(),
  subscribe: (listener) => {
    for (const entry of behaviour.logs) {
      listener(entry);
    }
    subscribers.add(listener);
    return () => {
      if (subscribers.delete(listener)) {
        unsubscribeCount += 1;
      }
    };
  },
  whenSettled: async () => behaviour.snapshot,
  log: () => {},
};

let server;
let baseUrl;
let webRoot;

before(async () => {
  webRoot = await mkdtemp(path.join(os.tmpdir(), 'lancache-warmer-api-'));
  await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>api test</title>');

  server = createServer({ webRoot, taskRunner: fakeRunner });
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

beforeEach(() => {
  behaviour.start = async () => ({ taskId: 'task-1', state: 'running' });
  behaviour.cancel = () => false;
  behaviour.snapshot = idleSnapshot();
  behaviour.logs = [];
  unsubscribeCount = 0;
});

after(async () => {
  for (const listener of subscribers) {
    subscribers.delete(listener);
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(webRoot, { recursive: true, force: true });
});

/**
 * @param {string} pathname
 * @param {unknown} body
 * @returns {Promise<Response>}
 */
function postJson(pathname, body) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {number} [timeoutMs]
 * @returns {Promise<ReadableStreamReadResult<Uint8Array>>}
 */
function readWithTimeout(reader, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for SSE data')), timeoutMs);
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 */
async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('POST /api/prefill starts a task and returns 202 with its id and state', async () => {
  let received;
  behaviour.start = async (appIds) => {
    received = appIds;
    return { taskId: 'task-9', state: 'running' };
  };

  const response = await postJson('/api/prefill', { appIds: [413150, 620] });

  assert.equal(response.status, 202);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await response.json(), { taskId: 'task-9', state: 'running' });
  assert.deepEqual(received, [413150, 620]);
});

test('POST /api/prefill maps a running task to 409', async () => {
  behaviour.start = async () => {
    throw new TaskConflictError('已有预填充任务在运行');
  };

  const response = await postJson('/api/prefill', { appIds: [413150] });

  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /运行/);
});

test('POST /api/prefill maps a missing token to 428 with a login hint', async () => {
  behaviour.start = async () => {
    throw new NotLoggedInError('未登录 Steam，请先扫码登录');
  };

  const response = await postJson('/api/prefill', { appIds: [413150] });

  assert.equal(response.status, 428);
  assert.match((await response.json()).error, /扫码登录/);
});

test('GET /api/task returns the current snapshot', async () => {
  behaviour.snapshot = {
    ...idleSnapshot(),
    state: 'running',
    appIds: [413150],
    startedAt: '2026-11-17T00:00:00.000Z',
  };

  const response = await fetch(`${baseUrl}/api/task`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), behaviour.snapshot);
});

test('POST /api/cancel forwards the request and reports whether it was accepted', async () => {
  behaviour.cancel = () => true;
  behaviour.snapshot = { ...idleSnapshot(), state: 'running', appIds: [413150] };

  const response = await fetch(`${baseUrl}/api/cancel`, { method: 'POST' });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { cancelled: true, state: 'running' });
});

test('API routes reject the wrong method with 405 and an Allow header', async () => {
  const prefill = await fetch(`${baseUrl}/api/prefill`);
  assert.equal(prefill.status, 405);
  assert.equal(prefill.headers.get('allow'), 'POST');

  const task = await fetch(`${baseUrl}/api/task`, { method: 'POST' });
  assert.equal(task.status, 405);
  assert.equal(task.headers.get('allow'), 'GET');

  const logs = await fetch(`${baseUrl}/api/logs`, { method: 'POST' });
  assert.equal(logs.status, 405);
  assert.equal(logs.headers.get('allow'), 'GET');

  const cancel = await fetch(`${baseUrl}/api/cancel`);
  assert.equal(cancel.status, 405);
  assert.equal(cancel.headers.get('allow'), 'POST');
});

test('GET /api/logs replays history, streams new lines and unsubscribes on disconnect', async () => {
  const history = {
    at: '2026-11-17T00:00:00.000Z',
    level: 'info',
    message: 'history line',
  };
  behaviour.logs = [history];

  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/logs`, { signal: controller.signal });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  /**
   * @returns {Promise<string>} The next SSE event line.
   */
  async function readEvent() {
    while (!buffer.includes('\n\n')) {
      const { value, done } = await readWithTimeout(reader);
      if (done) {
        throw new Error('SSE stream ended unexpectedly');
      }
      buffer += decoder.decode(value, { stream: true });
    }

    const boundary = buffer.indexOf('\n\n');
    const event = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    return event;
  }

  assert.equal(await readEvent(), `data: ${JSON.stringify(history)}`);

  const live = {
    at: '2026-11-17T00:00:01.000Z',
    level: 'warn',
    message: 'live line',
  };
  for (const listener of subscribers) {
    listener(live);
  }
  assert.equal(await readEvent(), `data: ${JSON.stringify(live)}`);

  controller.abort();
  await waitFor(() => unsubscribeCount === 1);
  assert.equal(subscribers.size, 0);
});
