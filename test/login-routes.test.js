import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';

import { createLoginRoutes } from '../src/api/login-routes.js';
import { cancelLogin } from '../src/providers/steam/login.js';
import { createServer } from '../src/server.js';

// Fake credential values: shaped like real records but never usable tokens.
const REFRESH_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.fake-refresh-token';
const STEAM_ID = '76561198000000000';
const QR_URL = 'https://s.team/q/2-fake-qr-challenge';
const NOW_MS = 1_700_000_000_123;
const STORED_TOKEN = { refreshToken: REFRESH_TOKEN, savedAt: 1_700_000_000, steamId: STEAM_ID };

/**
 * A `steam-session` stand-in. `startWithQR` never touches the network; tests
 * approve or fail the attempt by emitting the terminal events locally.
 */
class FakeLoginSession extends EventEmitter {
  constructor() {
    super();
    this.refreshToken = undefined;
    this.steamID = undefined;
    this.startCount = 0;
    this.cancelCount = 0;
  }

  async startWithQR() {
    this.startCount += 1;
    return { qrChallengeUrl: QR_URL };
  }

  cancelLoginAttempt() {
    this.cancelCount += 1;
    return false;
  }

  /** Simulate the user approving the code in the Steam mobile app. */
  approve() {
    this.refreshToken = REFRESH_TOKEN;
    this.steamID = { getSteamID64: () => STEAM_ID };
    this.emit('authenticated');
  }
}

let server;
let baseUrl;
let webRoot;
let routes;
let tokenState;
let saves;
let rendered;
let fakeSessions;

before(async () => {
  webRoot = await mkdtemp(path.join(os.tmpdir(), 'lancache-warmer-login-'));
});

after(async () => {
  await rm(webRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  tokenState = null;
  saves = [];
  rendered = [];
  fakeSessions = [];

  routes = createLoginRoutes({
    // In-memory token store: tests never read or write the real data dir.
    loadToken: async () => tokenState,
    clearToken: async () => {
      tokenState = null;
    },
    renderQrSvg: async (qrUrl) => {
      rendered.push(qrUrl);
      return `<svg data-url="${qrUrl}"></svg>`;
    },
    // Reuse login.js's own sessionFactory hook so the real login state machine
    // runs, but every session is a local fake.
    loginOptions: {
      sessionFactory: () => {
        const session = new FakeLoginSession();
        fakeSessions.push(session);
        return session;
      },
      saveToken: async (token) => {
        saves.push(token);
      },
      now: () => NOW_MS,
    },
    now: () => NOW_MS,
  });

  server = createServer({ webRoot, loginRoutes: routes });
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

afterEach(async () => {
  // Cancel any attempt a test left waiting, then stop the server.
  await routes.logout();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

/**
 * @param {string} pathname
 * @returns {Promise<Response>}
 */
function post(pathname) {
  return fetch(`${baseUrl}${pathname}`, { method: 'POST' });
}

/**
 * @param {string} sessionId
 * @returns {Promise<Response>}
 */
function getStatus(sessionId) {
  const query = sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`;
  return fetch(`${baseUrl}/api/login/status${query}`);
}

/**
 * Poll the status endpoint until it reports `state` (or the deadline passes).
 *
 * @param {string} sessionId
 * @param {string} state
 * @param {number} [timeoutMs]
 * @returns {Promise<object>}
 */
async function waitForState(sessionId, state, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() < deadline) {
    const response = await getStatus(sessionId);
    last = await response.json();
    if (last.state === state) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`status never became ${state}; last was ${JSON.stringify(last)}`);
}

test('POST /api/login/qr starts a login and returns the QR URL with rendered SVG', async () => {
  const response = await post('/api/login/qr');

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);

  const body = await response.json();
  assert.equal(typeof body.sessionId, 'string');
  assert.notEqual(body.sessionId, '');
  assert.equal(body.qrUrl, QR_URL);
  assert.match(body.qrSvg, /^<svg/);
  assert.ok(body.qrSvg.includes(QR_URL));
  assert.deepEqual(rendered, [QR_URL]);
  assert.equal(fakeSessions.length, 1);
  assert.equal(fakeSessions[0].startCount, 1);
  // The response must never expose a credential.
  assert.ok(!JSON.stringify(body).includes(REFRESH_TOKEN));
});

test('status is waiting before approval, then ok after the token is saved', async () => {
  const { sessionId } = await (await post('/api/login/qr')).json();

  const waiting = await getStatus(sessionId);
  assert.equal(waiting.status, 200);
  assert.deepEqual(await waiting.json(), { state: 'waiting' });

  fakeSessions[0].approve();

  const deadline = Date.now() + 2_000;
  while (saves.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.deepEqual(saves, [
    {
      refreshToken: REFRESH_TOKEN,
      savedAt: Math.floor(NOW_MS / 1000),
      steamId: STEAM_ID,
    },
  ]);

  const ok = await getStatus(sessionId);
  const text = await ok.text();
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(text), { state: 'ok' });
  assert.ok(!text.includes(REFRESH_TOKEN));
});

test('the default renderer turns the QR URL into an inline SVG', async () => {
  const localRoutes = createLoginRoutes({
    startLogin: async () => ({ qrUrl: QR_URL, sessionId: 'local-session' }),
    waitForToken: () => new Promise(() => {}),
    cancelLogin: () => true,
    loadToken: async () => null,
    clearToken: async () => {},
  });

  const result = await localRoutes.startQrLogin();
  assert.match(result.qrSvg, /^<svg /);
  assert.ok(result.qrSvg.includes('xmlns="http://www.w3.org/2000/svg"'));

  await localRoutes.logout();
});

test('a QR rendering failure cancels the started session', async () => {
  let cancelled = 0;
  const localRoutes = createLoginRoutes({
    startLogin: async () => ({ qrUrl: QR_URL, sessionId: 'broken-session' }),
    waitForToken: () => new Promise(() => {}),
    cancelLogin: (sessionId) => {
      cancelled += 1;
      assert.equal(sessionId, 'broken-session');
      return true;
    },
    loadToken: async () => null,
    clearToken: async () => {},
    renderQrSvg: async () => {
      throw new Error('no svg');
    },
  });

  await assert.rejects(() => localRoutes.startQrLogin(), /no svg/);
  assert.equal(cancelled, 1);
});

test('GET /api/login/status returns 404 for an unknown sessionId', async () => {
  const response = await getStatus('not-a-real-session');

  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /不存在/);
});

test('POST /api/login/qr returns 409 when a token is already stored', async () => {
  tokenState = STORED_TOKEN;

  const response = await post('/api/login/qr');

  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /已登录/);
  assert.equal(fakeSessions.length, 0);
});

test('status reports ok after a restart when a token is on disk', async () => {
  tokenState = STORED_TOKEN;

  const withoutSession = await getStatus();
  assert.equal(withoutSession.status, 200);
  assert.deepEqual(await withoutSession.json(), { state: 'ok' });

  // A browser may still send the id of a session that died with the old process.
  const stale = await getStatus('session-from-before-restart');
  assert.equal(stale.status, 200);
  assert.deepEqual(await stale.json(), { state: 'ok' });
});

test('a failed login becomes error with a readable message', async () => {
  const { sessionId } = await (await post('/api/login/qr')).json();

  fakeSessions[0].emit('timeout');

  const body = await waitForState(sessionId, 'error');
  assert.match(body.message, /timed out/);
  assert.ok(!JSON.stringify(body).includes(REFRESH_TOKEN));
});

test('a cancelled login becomes error with the cancellation message', async () => {
  const { sessionId } = await (await post('/api/login/qr')).json();

  // A caller may cancel through the login module (for example when the panel
  // closes); the tracked attempt must not stay `waiting` forever.
  assert.equal(cancelLogin(sessionId), true);

  const body = await waitForState(sessionId, 'error');
  assert.match(body.message, /cancelled/);
});

test('POST /api/logout clears the token and forgets existing sessions', async () => {
  const { sessionId } = await (await post('/api/login/qr')).json();
  fakeSessions[0].approve();
  const deadline = Date.now() + 2_000;
  while (saves.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  tokenState = STORED_TOKEN;

  const response = await post('/api/logout');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(tokenState, null);

  const oldSession = await getStatus(sessionId);
  assert.equal(oldSession.status, 404);

  const withoutSession = await getStatus();
  assert.equal(withoutSession.status, 404);
});

test('logout cancels a pending login attempt', async () => {
  await post('/api/login/qr');

  await post('/api/logout');

  assert.equal(fakeSessions[0].cancelCount, 1);
});

test('login routes reject the wrong method with 405 and an Allow header', async () => {
  const qr = await fetch(`${baseUrl}/api/login/qr`);
  assert.equal(qr.status, 405);
  assert.equal(qr.headers.get('allow'), 'POST');

  const status = await fetch(`${baseUrl}/api/login/status`, { method: 'POST' });
  assert.equal(status.status, 405);
  assert.equal(status.headers.get('allow'), 'GET');

  const logout = await fetch(`${baseUrl}/api/logout`);
  assert.equal(logout.status, 405);
  assert.equal(logout.headers.get('allow'), 'POST');
});
