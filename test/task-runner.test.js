import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createTaskRunner,
  NotLoggedInError,
  TaskConflictError,
  TaskValidationError,
} from '../src/api/task-runner.js';

/**
 * Structurally valid (but unsigned) refresh token. `steam-user` only decodes
 * the payload for its own validation, so this shape is enough for the runner
 * check; the fake `connect` never sees a real login.
 */
const REFRESH_TOKEN = [
  Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
  Buffer.from(JSON.stringify({
    iss: 'steam',
    aud: ['client'],
    sub: '76561198000000000',
  })).toString('base64url'),
  'signature',
].join('.');

const TOKEN = {
  refreshToken: REFRESH_TOKEN,
  savedAt: 1_700_000_000,
  steamId: '76561198000000000',
};
const HOSTS = ['cache1-tyo3.steamcontent.com'];

/**
 * Build a runner whose external effects are all local fakes. Tests override
 * only the dependency they exercise.
 *
 * @param {object} [overrides]
 * @returns {ReturnType<typeof createTaskRunner>}
 */
function createRunner(overrides = {}) {
  return createTaskRunner({
    loadToken: async () => TOKEN,
    connect: async () => ({ getContentServers: async () => ({ servers: HOSTS }) }),
    getHosts: async () => HOSTS,
    prefillApp: async () => ({ chunks: 0, failed: 0, bytes: 0, hit: 0, miss: 0 }),
    now: () => 1_000,
    ...overrides,
  });
}

/**
 * A promise plus its resolver, used to hold a task open while a test inspects
 * the running state.
 *
 * @returns {{ promise: Promise<void>, resolve: () => void }}
 */
function deferred() {
  /** @type {() => void} */
  let resolve = () => {};
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test('start returns immediately and settles as done with cumulative progress', async () => {
  const gate = deferred();
  /** @type {{ appId: number, hosts: string[], shouldStop: unknown }[]} */
  const calls = [];

  const runner = createRunner({
    prefillApp: async (user, appId, opts) => {
      calls.push({ appId, hosts: opts.hosts, shouldStop: opts.shouldStop });
      opts.onProgress({ chunksOk: 2, chunksFailed: 0, bytes: 100, hit: 1, miss: 1 });
      await gate.promise;
      return { chunks: 2, failed: 0, bytes: 100, hit: 1, miss: 1 };
    },
  });

  const started = await runner.start([413150, 620]);

  assert.match(started.taskId, /^[0-9a-f-]{36}$/);
  assert.equal(started.state, 'running');

  const running = runner.getSnapshot();
  assert.equal(running.state, 'running');
  assert.deepEqual(running.appIds, [413150, 620]);
  assert.equal(running.startedAt, new Date(1_000).toISOString());
  assert.equal(running.finishedAt, null);
  assert.equal(running.error, null);

  gate.resolve();
  const final = await runner.whenSettled();

  assert.equal(final.state, 'done');
  assert.deepEqual(final.progress, {
    appsDone: 2,
    appsTotal: 2,
    chunksOk: 4,
    chunksFailed: 0,
    bytes: 200,
    hit: 2,
    miss: 2,
  });
  assert.equal(final.finishedAt, new Date(1_000).toISOString());
  assert.equal(final.error, null);

  // Each app ran once, in order, with the resolved hosts and a stop callback.
  assert.deepEqual(calls.map(({ appId }) => appId), [413150, 620]);
  for (const call of calls) {
    assert.deepEqual(call.hosts, HOSTS);
    assert.equal(typeof call.shouldStop, 'function');
  }

  // The final log line records the end of the task.
  assert.match(runner.getLogs().at(-1).message, /任务完成/);
});

test('a second start is rejected while the first task is still running', async () => {
  const gate = deferred();
  const runner = createRunner({
    prefillApp: async () => {
      await gate.promise;
      return { chunks: 0, failed: 0, bytes: 0, hit: 0, miss: 0 };
    },
  });

  const first = runner.start([1]);
  // The first start is still reading its token, so this hits the same guard.
  const overlapping = runner.start([2]);

  await assert.rejects(overlapping, (error) => error instanceof TaskConflictError);
  await first;

  await assert.rejects(() => runner.start([3]), (error) => error instanceof TaskConflictError);

  gate.resolve();
  assert.equal((await runner.whenSettled()).state, 'done');
});

test('the log buffer keeps only the most recent 500 lines', () => {
  const runner = createRunner();

  for (let index = 1; index <= 600; index += 1) {
    runner.log('info', `line ${index}`);
  }

  const logs = runner.getLogs();
  assert.equal(logs.length, 500);
  assert.equal(logs[0].message, 'line 101');
  assert.equal(logs.at(-1).message, 'line 600');
});

test('subscribe replays the buffer, receives new lines and stops after unsubscribe', () => {
  const runner = createRunner();
  for (let index = 1; index <= 3; index += 1) {
    runner.log('info', `history ${index}`);
  }

  /** @type {string[]} */
  const received = [];
  const unsubscribe = runner.subscribe((entry) => received.push(entry.message));

  assert.deepEqual(received, ['history 1', 'history 2', 'history 3']);

  runner.log('info', 'live');
  assert.equal(received.at(-1), 'live');

  unsubscribe();
  unsubscribe();
  runner.log('info', 'after unsubscribe');

  assert.equal(received.length, 4);
  assert.equal(received.at(-1), 'live');
});

test('a throwing subscriber cannot break logging or the task', async () => {
  const runner = createRunner({
    prefillApp: async () => ({ chunks: 1, failed: 0, bytes: 10, hit: 0, miss: 1 }),
  });

  runner.subscribe(() => {
    throw new Error('subscriber failed');
  });

  await runner.start([1]);
  assert.equal((await runner.whenSettled()).state, 'done');
  assert.match(runner.getLogs().at(-1).message, /任务完成/);
});

test('cancel turns a running task into cancelled through shouldStop', async () => {
  let started;
  const prefillStarted = new Promise((resolve) => {
    started = resolve;
  });

  const runner = createRunner({
    prefillApp: async (user, appId, opts) => {
      started();
      // Poll the callback the same way the real download pool does; the test
      // does not rely on a chunk still being in flight.
      while (!opts.shouldStop()) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return { chunks: 5, failed: 0, bytes: 0, hit: 0, miss: 0 };
    },
  });

  await runner.start([413150]);
  await prefillStarted;

  assert.equal(runner.cancel(), true);
  assert.equal(runner.getSnapshot().state, 'running');

  const final = await runner.whenSettled();
  assert.equal(final.state, 'cancelled');
  assert.equal(final.error, null);
  assert.notEqual(final.finishedAt, null);
  assert.match(runner.getLogs().at(-1).message, /任务已取消/);

  // Cancelling again once the task settled is a no-op.
  assert.equal(runner.cancel(), false);
});

test('cancel does nothing when no task is running', () => {
  const runner = createRunner();
  assert.equal(runner.cancel(), false);
  assert.equal(runner.getSnapshot().state, 'idle');
});

test('a task that throws ends as failed with the error message', async () => {
  const runner = createRunner({
    prefillApp: async () => {
      throw new Error('boom');
    },
  });

  await runner.start([413150]);
  const final = await runner.whenSettled();

  assert.equal(final.state, 'failed');
  assert.equal(final.error, 'boom');
  assert.notEqual(final.finishedAt, null);

  const last = runner.getLogs().at(-1);
  assert.equal(last.level, 'error');
  assert.match(last.message, /boom/);
});

test('a missing token rejects the start and leaves the runner idle', async () => {
  const runner = createRunner({ loadToken: async () => null });

  await assert.rejects(
    () => runner.start([413150]),
    (error) => error instanceof NotLoggedInError && /扫码登录/.test(error.message),
  );

  const snapshot = runner.getSnapshot();
  assert.equal(snapshot.state, 'idle');
  assert.deepEqual(snapshot.appIds, []);
  assert.equal(snapshot.startedAt, null);
});

test('a malformed token is treated as not logged in instead of crashing steam-user', async () => {
  const runner = createRunner({
    loadToken: async () => ({ ...TOKEN, refreshToken: 'not-a-jwt' }),
  });

  await assert.rejects(
    () => runner.start([413150]),
    (error) => error instanceof NotLoggedInError && /扫码登录/.test(error.message),
  );

  assert.equal(runner.getSnapshot().state, 'idle');
});

test('appIds must be a non-empty array of positive integers', async () => {
  const runner = createRunner();
  const invalidValues = [
    undefined,
    null,
    '413150',
    {},
    [],
    [0],
    [-1],
    [1.5],
    ['413150'],
    [Number.NaN],
    [Number.MAX_SAFE_INTEGER + 1],
  ];

  for (const value of invalidValues) {
    await assert.rejects(
      () => runner.start(value),
      (error) => error instanceof TaskValidationError,
      `expected ${String(value)} to be rejected`,
    );
  }

  assert.equal(runner.getSnapshot().state, 'idle');
});

test('resolves content hosts from the connected Steam user by default', async () => {
  /** @type {unknown[]} */
  let receivedHosts;
  const runner = createTaskRunner({
    loadToken: async () => TOKEN,
    connect: async () => ({
      getContentServers: async () => ({
        servers: [
          { Host: 'cache1-tyo3.steamcontent.com', type: 'CDN' },
          { Host: 'cloudflare.steamstatic.com', type: 'CDN' },
          { Host: 'cache2-tyo3.steamcontent.com', type: 'SteamCache' },
        ],
      }),
    }),
    prefillApp: async (user, appId, opts) => {
      receivedHosts = opts.hosts;
      return { chunks: 0, failed: 0, bytes: 0, hit: 0, miss: 0 };
    },
    now: () => 1_000,
  });

  await runner.start([413150]);
  assert.equal((await runner.whenSettled()).state, 'done');

  // Public CDN nodes are dropped; only Steam content cache hosts remain.
  assert.deepEqual(receivedHosts, [
    'cache1-tyo3.steamcontent.com',
    'cache2-tyo3.steamcontent.com',
  ]);
});

test('a failed host lookup ends the task as failed without prefilling', async () => {
  let prefillCalls = 0;
  const runner = createRunner({
    getHosts: async () => [],
    prefillApp: async () => {
      prefillCalls += 1;
      return { chunks: 0, failed: 0, bytes: 0, hit: 0, miss: 0 };
    },
  });

  await runner.start([413150]);
  const final = await runner.whenSettled();

  assert.equal(final.state, 'failed');
  assert.match(final.error, /413150/);
  assert.equal(prefillCalls, 0);
});
