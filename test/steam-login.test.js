import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { cancelLogin, startLogin, waitForToken } from '../src/providers/steam/login.js';
import { loadToken } from '../src/providers/steam/token-store.js';

// Fake credential values: shaped like real records but not usable tokens.
const REFRESH_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.fake-refresh-token';
const STEAM_ID = '76561198000000000';
const QR_URL = 'https://s.team/q/1-fake-qr-challenge';
const NOW = 1_700_000_000_123;

/**
 * A `steam-session` stand-in. It never touches the network: `startWithQR`
 * resolves (or rejects) locally and the terminal events are emitted by the
 * test through `emit()`.
 */
class FakeLoginSession extends EventEmitter {
  /**
   * @param {{ qrUrl?: string, startError?: Error | null }} [options]
   */
  constructor({ qrUrl = QR_URL, startError = null } = {}) {
    super();
    this.qrUrl = qrUrl;
    this.startError = startError;
    this.startCount = 0;
    this.cancelCount = 0;
    this.refreshToken = undefined;
    this.steamID = undefined;
  }

  async startWithQR() {
    this.startCount += 1;
    if (this.startError !== null) {
      throw this.startError;
    }
    return { qrChallengeUrl: this.qrUrl };
  }

  cancelLoginAttempt() {
    this.cancelCount += 1;
    return false;
  }
}

/**
 * Record every saveToken call without touching the filesystem.
 *
 * @returns {{ calls: { token: object, opts: object }[], fn: Function }}
 */
function createSaveSpy() {
  /** @type {{ token: object, opts: object }[]} */
  const calls = [];
  return {
    calls,
    fn: async (token, opts) => {
      calls.push({ token, opts });
    },
  };
}

/**
 * @template T
 * @param {(dataDir: string) => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withTempDir(run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lancache-warmer-login-'));
  try {
    return await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('startLogin returns the QR URL and a unique session id', async () => {
  const first = new FakeLoginSession();
  const second = new FakeLoginSession();
  const pending = [first, second];

  const firstResult = await startLogin({ sessionFactory: () => pending.shift() });
  const secondResult = await startLogin({ sessionFactory: () => pending.shift() });

  assert.equal(firstResult.qrUrl, QR_URL);
  assert.equal(secondResult.qrUrl, QR_URL);
  assert.match(firstResult.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(firstResult.sessionId, secondResult.sessionId);
  assert.equal(first.startCount, 1);
  assert.equal(second.startCount, 1);

  assert.equal(cancelLogin(firstResult.sessionId), true);
  assert.equal(cancelLogin(secondResult.sessionId), true);
});

test('waitForToken resolves with the token and saves it once', async () => {
  const session = new FakeLoginSession();
  const save = createSaveSpy();
  const { sessionId } = await startLogin({
    sessionFactory: () => session,
    saveToken: save.fn,
    dataDir: '/fake/data',
    now: () => NOW,
  });

  const pending = waitForToken(sessionId);

  session.refreshToken = REFRESH_TOKEN;
  session.steamID = STEAM_ID;
  session.emit('authenticated');

  assert.deepEqual(await pending, { refreshToken: REFRESH_TOKEN, steamId: STEAM_ID });
  assert.deepEqual(save.calls, [
    {
      token: {
        refreshToken: REFRESH_TOKEN,
        savedAt: Math.floor(NOW / 1000),
        steamId: STEAM_ID,
      },
      opts: { dataDir: '/fake/data' },
    },
  ]);
  // The finished attempt is gone: cancelling again is a no-op.
  assert.equal(cancelLogin(sessionId), false);
  assert.equal(session.listenerCount('authenticated'), 0);
  assert.equal(session.listenerCount('error'), 0);
  assert.equal(session.listenerCount('timeout'), 0);
});

test('waitForToken converts a SteamID object to its 64-bit string', async () => {
  const session = new FakeLoginSession();
  const save = createSaveSpy();
  const { sessionId } = await startLogin({
    sessionFactory: () => session,
    saveToken: save.fn,
  });

  const pending = waitForToken(sessionId);

  session.refreshToken = REFRESH_TOKEN;
  session.steamID = { getSteamID64: () => STEAM_ID };
  session.emit('authenticated');

  assert.deepEqual(await pending, { refreshToken: REFRESH_TOKEN, steamId: STEAM_ID });
  assert.equal(save.calls.length, 1);
  assert.equal(save.calls[0].token.steamId, STEAM_ID);
});

test('waitForToken persists the token through the token store', async () => {
  await withTempDir(async (dataDir) => {
    const session = new FakeLoginSession();
    const { sessionId } = await startLogin({
      sessionFactory: () => session,
      dataDir,
      now: () => NOW,
    });

    const pending = waitForToken(sessionId);
    session.refreshToken = REFRESH_TOKEN;
    session.steamID = STEAM_ID;
    session.emit('authenticated');

    assert.deepEqual(await pending, { refreshToken: REFRESH_TOKEN, steamId: STEAM_ID });
    assert.deepEqual(await loadToken({ dataDir }), {
      refreshToken: REFRESH_TOKEN,
      savedAt: Math.floor(NOW / 1000),
      steamId: STEAM_ID,
    });
  });
});

test('waitForToken options override the ones from startLogin', async () => {
  const session = new FakeLoginSession();
  const startSave = createSaveSpy();
  const waitSave = createSaveSpy();
  const { sessionId } = await startLogin({
    sessionFactory: () => session,
    saveToken: startSave.fn,
    dataDir: '/fake/start',
    now: () => NOW,
  });

  const pending = waitForToken(sessionId, {
    saveToken: waitSave.fn,
    dataDir: '/fake/wait',
    now: () => NOW + 1000,
  });

  session.refreshToken = REFRESH_TOKEN;
  session.steamID = STEAM_ID;
  session.emit('authenticated');

  await pending;
  assert.equal(startSave.calls.length, 0);
  assert.deepEqual(waitSave.calls, [
    {
      token: {
        refreshToken: REFRESH_TOKEN,
        savedAt: Math.floor((NOW + 1000) / 1000),
        steamId: STEAM_ID,
      },
      opts: { dataDir: '/fake/wait' },
    },
  ]);
});

test('an error event rejects with a readable reason and saves nothing', async () => {
  const session = new FakeLoginSession();
  const save = createSaveSpy();
  const { sessionId } = await startLogin({
    sessionFactory: () => session,
    saveToken: save.fn,
  });

  const pending = waitForToken(sessionId);
  session.emit('error', new Error('Steam is unavailable'));

  await assert.rejects(pending, /Steam login failed: Steam is unavailable/);
  assert.equal(save.calls.length, 0);
  assert.equal(cancelLogin(sessionId), false);
  await assert.rejects(waitForToken(sessionId), /Unknown Steam login session/);
});

test('a timeout event rejects with a readable reason', async () => {
  const session = new FakeLoginSession();
  const { sessionId } = await startLogin({ sessionFactory: () => session });

  const pending = waitForToken(sessionId);
  session.emit('timeout');

  await assert.rejects(pending, /Steam login timed out/);
  assert.equal(session.listenerCount('timeout'), 0);
});

test('a missing refresh token rejects instead of saving a broken record', async () => {
  const session = new FakeLoginSession();
  const save = createSaveSpy();
  const { sessionId } = await startLogin({
    sessionFactory: () => session,
    saveToken: save.fn,
  });

  const pending = waitForToken(sessionId);
  // `authenticated` fired without the documented fields being populated.
  session.steamID = STEAM_ID;
  session.emit('authenticated');

  await assert.rejects(pending, /without a refresh token/);
  assert.equal(save.calls.length, 0);
});

test('a missing SteamID rejects instead of saving a broken record', async () => {
  const session = new FakeLoginSession();
  const save = createSaveSpy();
  const { sessionId } = await startLogin({
    sessionFactory: () => session,
    saveToken: save.fn,
  });

  const pending = waitForToken(sessionId);
  session.refreshToken = REFRESH_TOKEN;
  session.emit('authenticated');

  await assert.rejects(pending, /without a SteamID/);
  assert.equal(save.calls.length, 0);
});

test('cancelLogin rejects a pending wait, stops the session and is idempotent', async () => {
  const session = new FakeLoginSession();
  const { sessionId } = await startLogin({ sessionFactory: () => session });

  const pending = waitForToken(sessionId);
  assert.equal(cancelLogin(sessionId), true);

  await assert.rejects(pending, /Steam login was cancelled/);
  assert.equal(session.cancelCount, 1);
  assert.equal(cancelLogin(sessionId), false);
  assert.equal(session.listenerCount('authenticated'), 0);
  assert.equal(session.listenerCount('error'), 0);
  await assert.rejects(waitForToken(sessionId), /Unknown Steam login session/);
});

test('cancelLogin tolerates an unknown session id', () => {
  assert.equal(cancelLogin('00000000-0000-4000-8000-000000000000'), false);
});

test('waitForToken rejects for an unknown session id', async () => {
  await assert.rejects(
    waitForToken('00000000-0000-4000-8000-000000000000'),
    /Unknown Steam login session: 00000000-0000-4000-8000-000000000000/,
  );
});

test('concurrent waitForToken calls share one attempt and one save', async () => {
  const session = new FakeLoginSession();
  const save = createSaveSpy();
  const { sessionId } = await startLogin({
    sessionFactory: () => session,
    saveToken: save.fn,
  });

  const first = waitForToken(sessionId);
  const second = waitForToken(sessionId);
  assert.equal(first, second);

  session.refreshToken = REFRESH_TOKEN;
  session.steamID = STEAM_ID;
  session.emit('authenticated');

  assert.deepEqual(await Promise.all([first, second]), [
    { refreshToken: REFRESH_TOKEN, steamId: STEAM_ID },
    { refreshToken: REFRESH_TOKEN, steamId: STEAM_ID },
  ]);
  assert.equal(save.calls.length, 1);
});

test('waitForToken resolves when the session authenticated before it was awaited', async () => {
  const session = new FakeLoginSession();
  const save = createSaveSpy();
  const { sessionId } = await startLogin({
    sessionFactory: () => session,
    saveToken: save.fn,
  });

  // Simulate the event firing between startLogin and waitForToken.
  session.refreshToken = REFRESH_TOKEN;
  session.steamID = STEAM_ID;

  assert.deepEqual(await waitForToken(sessionId), {
    refreshToken: REFRESH_TOKEN,
    steamId: STEAM_ID,
  });
  assert.equal(save.calls.length, 1);
});

test('startLogin rejects when Steam cannot start a QR attempt', async () => {
  const session = new FakeLoginSession({ startError: new Error('Steam is down') });

  await assert.rejects(
    startLogin({ sessionFactory: () => session }),
    /Steam is down/,
  );
  assert.equal(session.startCount, 1);
  assert.equal(session.cancelCount, 1);
});

test('startLogin rejects when no QR challenge URL is returned', async () => {
  const session = new FakeLoginSession({ qrUrl: '' });

  await assert.rejects(
    startLogin({ sessionFactory: () => session }),
    /did not return a QR code URL/,
  );
  assert.equal(session.cancelCount, 1);
});

test('the login flow never logs the refresh token', async () => {
  const session = new FakeLoginSession();
  const captured = [];
  const originals = new Map();

  for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
    originals.set(name, console[name]);
    console[name] = (...args) => captured.push(args.map(String).join(' '));
  }

  try {
    const { sessionId } = await startLogin({ sessionFactory: () => session });
    const pending = waitForToken(sessionId);
    session.refreshToken = REFRESH_TOKEN;
    session.steamID = STEAM_ID;
    session.emit('authenticated');
    await pending;
  } finally {
    for (const [name, original] of originals) {
      console[name] = original;
    }
  }

  assert.ok(
    captured.every((message) => !message.includes(REFRESH_TOKEN)),
    'no log line may contain the refresh token',
  );
});
