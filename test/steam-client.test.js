import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { connect, disconnect, getUser } from '../src/providers/steam/client.js';

const TOKEN = 'refresh-token-a';
const OTHER_TOKEN = 'refresh-token-b';

// The module owns one singleton connection, so every test starts and ends
// disconnected. Tests never construct a real steam-user instance.
afterEach(() => {
  disconnect();
});

/**
 * Fake `steam-user` factory. Each instance records logOn/logOff calls and lets
 * the test emit `loggedOn`/`error` locally.
 *
 * @returns {{
 *   factory: (options: object) => object,
 *   instances: any[],
 * }}
 */
function createFakeFactory() {
  /** @type {any[]} */
  const instances = [];

  const factory = (options) => {
    /** @type {Map<string, Set<(...args: any[]) => void>>} */
    const listeners = new Map();

    const fake = {
      options,
      logOnCalls: [],
      logOffCalls: 0,
      offed: false,

      logOn(details) {
        this.logOnCalls.push(details);
      },
      logOff() {
        this.logOffCalls += 1;
        this.offed = true;
      },
      on(event, listener) {
        if (!listeners.has(event)) {
          listeners.set(event, new Set());
        }
        listeners.get(event).add(listener);
      },
      removeListener(event, listener) {
        listeners.get(event)?.delete(listener);
      },
      emit(event, ...args) {
        for (const listener of [...(listeners.get(event) ?? [])]) {
          listener(...args);
        }
      },
      listenerCount(event) {
        return listeners.get(event)?.size ?? 0;
      },
    };

    instances.push(fake);
    return fake;
  };

  return { factory, instances };
}

/**
 * Connect with a fake and emit `loggedOn`, returning the resolved instance.
 *
 * @param {ReturnType<typeof createFakeFactory>} fakes
 * @param {string} [token]
 * @returns {Promise<any>}
 */
async function login(fakes, token = TOKEN) {
  const promise = connect({ refreshToken: token, steamUserFactory: fakes.factory });
  const instance = fakes.instances.at(-1);
  instance.emit('loggedOn', {});
  return promise;
}

test('connect requires a non-empty refreshToken and throws TypeError synchronously', () => {
  assert.throws(() => connect(), TypeError);
  assert.throws(() => connect({}), TypeError);
  assert.throws(() => connect({ refreshToken: '' }), TypeError);
  assert.throws(() => connect({ refreshToken: '   ' }), TypeError);
  assert.throws(() => connect({ refreshToken: 42 }), TypeError);
  assert.equal(getUser(), null);
});

test('connect creates steam-user with autoRelogin, logs on and resolves after loggedOn', async () => {
  const fakes = createFakeFactory();

  const promise = connect({ refreshToken: TOKEN, steamUserFactory: fakes.factory });

  assert.equal(fakes.instances.length, 1);
  assert.deepEqual(fakes.instances[0].options, { autoRelogin: true });
  // logOn 额外带上 logonID / machineName：缺这两个时 Steam 回 loggedOn 很慢
  assert.equal(fakes.instances[0].logOnCalls.length, 1);
  assert.equal(fakes.instances[0].logOnCalls[0].refreshToken, TOKEN);
  assert.equal(typeof fakes.instances[0].logOnCalls[0].machineName, 'string');
  // Not connected until Steam confirms the login.
  assert.equal(getUser(), null);

  fakes.instances[0].emit('loggedOn', {});

  assert.equal(await promise, fakes.instances[0]);
  assert.equal(getUser(), fakes.instances[0]);
  assert.equal(fakes.instances[0].logOnCalls.length, 1);
});

test('a second connect with the same token reuses the instance without logging on again', async () => {
  const fakes = createFakeFactory();
  const first = await login(fakes);

  const second = await connect({ refreshToken: TOKEN, steamUserFactory: fakes.factory });

  assert.equal(second, first);
  assert.equal(fakes.instances.length, 1);
  assert.equal(first.logOnCalls.length, 1);
});

test('concurrent connects with the same token share one in-flight login', async () => {
  const fakes = createFakeFactory();

  const first = connect({ refreshToken: TOKEN, steamUserFactory: fakes.factory });
  const second = connect({ refreshToken: TOKEN, steamUserFactory: fakes.factory });

  assert.equal(first, second);
  assert.equal(fakes.instances.length, 1);
  assert.equal(fakes.instances[0].logOnCalls.length, 1);

  fakes.instances[0].emit('loggedOn', {});
  assert.equal(await first, fakes.instances[0]);
  assert.equal(await second, fakes.instances[0]);
});

test('a different token logs the old instance off before creating a new one', async () => {
  const fakes = createFakeFactory();
  const first = await login(fakes);

  const promise = connect({ refreshToken: OTHER_TOKEN, steamUserFactory: fakes.factory });

  assert.equal(first.offed, true);
  assert.equal(first.logOffCalls, 1);
  assert.equal(fakes.instances.length, 2);
  assert.equal(fakes.instances[1].logOnCalls[0].refreshToken, OTHER_TOKEN);
  assert.equal(getUser(), null);

  fakes.instances[1].emit('loggedOn', {});
  const second = await promise;

  assert.equal(second, fakes.instances[1]);
  assert.equal(getUser(), second);
});

test('connect rejects with a 登录超时 error when loggedOn never arrives', async () => {
  const fakes = createFakeFactory();

  await assert.rejects(
    connect({ refreshToken: TOKEN, timeoutMs: 10, steamUserFactory: fakes.factory }),
    (error) => error instanceof Error && /登录超时/.test(error.message),
  );

  assert.equal(getUser(), null);
  // The abandoned instance is logged off and cannot become the singleton.
  assert.equal(fakes.instances[0].offed, true);
  fakes.instances[0].emit('loggedOn', {});
  assert.equal(getUser(), null);
});

test('an error before loggedOn rejects the connect promise', async () => {
  const fakes = createFakeFactory();

  const promise = connect({ refreshToken: TOKEN, steamUserFactory: fakes.factory });
  const failure = new Error('invalid refresh token');
  fakes.instances[0].emit('error', failure);

  await assert.rejects(promise, (error) => error === failure);
  assert.equal(getUser(), null);
  assert.equal(fakes.instances[0].offed, true);
});

test('an error after loggedOn is recorded without rejecting or crashing', async () => {
  const fakes = createFakeFactory();
  /** @type {unknown[][]} */
  const logs = [];
  const logger = { error: (...args) => logs.push(args) };

  const promise = connect({
    refreshToken: TOKEN,
    steamUserFactory: fakes.factory,
    logger,
  });
  fakes.instances[0].emit('loggedOn', {});
  const connected = await promise;

  assert.doesNotThrow(() => {
    fakes.instances[0].emit('error', new Error(`CM error for ${TOKEN}`));
  });

  assert.equal(getUser(), connected);
  assert.equal(logs.length, 1);
  const message = String(logs[0][1]);
  assert.match(message, /CM error/);
  // A post-login error must never print the refresh token.
  assert.equal(message.includes(TOKEN), false);
  assert.match(message, /\[redacted\]/);
});

test('disconnect logs off, clears the singleton and is a no-op without a connection', async () => {
  await disconnect();
  assert.equal(getUser(), null);

  const fakes = createFakeFactory();
  const connected = await login(fakes);

  await disconnect();

  assert.equal(connected.offed, true);
  assert.equal(getUser(), null);

  // Calling it again must not throw.
  await disconnect();
  assert.equal(connected.logOffCalls, 1);
});

test('disconnect rejects an in-flight login and prevents a late loggedOn', async () => {
  const fakes = createFakeFactory();

  const promise = connect({ refreshToken: TOKEN, steamUserFactory: fakes.factory });
  disconnect();

  await assert.rejects(promise, /已断开/);
  assert.equal(getUser(), null);

  fakes.instances[0].emit('loggedOn', {});
  assert.equal(getUser(), null);
});

test('a fake without removeListener still works', async () => {
  const listeners = new Map();
  const fake = {
    logOnCalls: [],
    logOn(details) {
      this.logOnCalls.push(details);
    },
    logOff() {},
    on(event, listener) {
      listeners.set(event, listener);
    },
  };
  const factory = () => fake;

  const promise = connect({ refreshToken: TOKEN, steamUserFactory: factory });
  listeners.get('loggedOn')();

  assert.equal(await promise, fake);
  assert.equal(getUser(), fake);
});
