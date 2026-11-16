/**
 * HTTP routes for Steam QR login.
 *
 * Wraps the login provider and the token store into the three endpoints the web
 * panel needs. The module never creates or owns an `http.Server`: `server.js`
 * only routes the paths listed in `LOGIN_PATHS` here, passing the Node request
 * and response objects. That keeps the state machine testable over plain HTTP
 * with injected fakes.
 *
 * A started login is tracked in memory so `/api/login/status` can report
 * `waiting` after the QR code was handed out, then `ok` or `error` once
 * `waitForToken` settles. The resolved token is deliberately never stored or
 * logged; a successful wait only flips the state, because `waitForToken` has
 * already persisted the token through `token-store`. A stored token is also the
 * source of truth for `ok` after a process restart, when no in-memory session
 * exists anymore.
 *
 * The QR code is rendered with `qrcode` (pure JS, no canvas) into an SVG
 * string, which the panel can embed directly.
 */

import QRCode from 'qrcode';

import {
  cancelLogin as cancelLoginDefault,
  startLogin as startLoginDefault,
  waitForToken as waitForTokenDefault,
} from '../providers/steam/login.js';
import {
  clearToken as clearTokenDefault,
  loadToken as loadTokenDefault,
} from '../providers/steam/token-store.js';

/** API paths owned by this module. */
export const LOGIN_PATHS = new Set(['/api/login/qr', '/api/login/status', '/api/logout']);

/**
 * Settled sessions are forgotten after this long. Waiting sessions are kept
 * until `waitForToken` settles or the attempt is cancelled.
 */
const DEFAULT_SETTLED_TTL_MS = 10 * 60 * 1000;

/** Upper bound on retained sessions, so a long-running process cannot grow. */
const DEFAULT_MAX_SESSIONS = 100;

/**
 * @typedef {'waiting' | 'ok' | 'error'} LoginState
 */

/**
 * One tracked login attempt.
 *
 * @typedef {Object} LoginSessionEntry
 * @property {LoginState} state
 * @property {string | null} message Readable reason when `state` is `error`.
 * @property {number} startedAt Unix time in milliseconds.
 * @property {number | null} settledAt Unix time in milliseconds, or null while
 *   the attempt is still waiting for the user.
 */

/**
 * @typedef {Object} LoginStatus
 * @property {LoginState} state
 * @property {string} [message] Present when `state` is `error`.
 */

/**
 * @typedef {Object} StartQrLoginResult
 * @property {string} sessionId Opaque id for `/api/login/status`.
 * @property {string} qrUrl `https://s.team/q/...` URL encoded in the QR code.
 * @property {string} qrSvg SVG markup for that URL.
 */

/**
 * @typedef {(qrUrl: string) => Promise<string>} RenderQrSvgFn
 */

/**
 * Options forwarded to both `startLogin` and `waitForToken`. This is where the
 * `sessionFactory`, `saveToken`, `dataDir` and `now` test/embedding hooks live;
 * production uses the provider defaults.
 *
 * @typedef {Object} LoginModuleOptions
 * @property {() => any} [sessionFactory]
 * @property {(token: object, opts: object) => Promise<void>} [saveToken]
 * @property {string} [dataDir]
 * @property {() => number} [now]
 */

/**
 * @typedef {Object} CreateLoginRoutesOptions
 * @property {typeof startLoginDefault} [startLogin]
 * @property {typeof waitForTokenDefault} [waitForToken]
 * @property {typeof cancelLoginDefault} [cancelLogin]
 * @property {typeof loadTokenDefault} [loadToken]
 * @property {typeof clearTokenDefault} [clearToken]
 * @property {RenderQrSvgFn} [renderQrSvg] Defaults to an SVG rendered with
 *   `qrcode`; tests inject a fake.
 * @property {LoginModuleOptions} [loginOptions] Forwarded to the login module.
 * @property {() => number} [now] Clock for session bookkeeping; defaults to
 *   `Date.now`.
 * @property {number} [settledTtlMs] How long a settled session is retained.
 * @property {number} [maxSessions] Maximum number of retained sessions.
 */

/** A stored token already exists, so starting another QR login is pointless. */
export class AlreadyLoggedInError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AlreadyLoggedInError';
  }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {asserts value is Function}
 */
function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
}

/**
 * @param {string} qrUrl
 * @returns {Promise<string>}
 */
async function renderQrSvgWithQrcode(qrUrl) {
  return QRCode.toString(qrUrl, { type: 'svg', margin: 1 });
}

/**
 * @param {unknown} error
 * @returns {string} Error message that is safe to return to the browser.
 */
function loginErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim();
  return trimmed === '' ? 'Steam 登录失败' : trimmed;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {unknown} payload
 */
function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} allow
 */
function sendMethodNotAllowed(res, allow) {
  const body = Buffer.from('Method Not Allowed');
  res.writeHead(405, {
    Allow: allow,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

/**
 * Build the login route handlers.
 *
 * @param {CreateLoginRoutesOptions} [options]
 * @returns {{
 *   handle: (
 *     req: import('node:http').IncomingMessage,
 *     res: import('node:http').ServerResponse,
 *     pathname: string,
 *     searchParams?: URLSearchParams,
 *   ) => Promise<boolean>,
 *   startQrLogin: () => Promise<StartQrLoginResult>,
 *   getStatus: (sessionId?: string | null) => Promise<LoginStatus | null>,
 *   logout: () => Promise<{ ok: true }>,
 * }}
 */
export function createLoginRoutes(options = {}) {
  const opts = options ?? {};
  const {
    startLogin = startLoginDefault,
    waitForToken = waitForTokenDefault,
    cancelLogin = cancelLoginDefault,
    loadToken = loadTokenDefault,
    clearToken = clearTokenDefault,
    renderQrSvg = renderQrSvgWithQrcode,
    loginOptions = {},
    now = Date.now,
    settledTtlMs = DEFAULT_SETTLED_TTL_MS,
    maxSessions = DEFAULT_MAX_SESSIONS,
  } = opts;

  assertFunction(startLogin, 'options.startLogin');
  assertFunction(waitForToken, 'options.waitForToken');
  assertFunction(cancelLogin, 'options.cancelLogin');
  assertFunction(loadToken, 'options.loadToken');
  assertFunction(clearToken, 'options.clearToken');
  assertFunction(renderQrSvg, 'options.renderQrSvg');
  assertFunction(now, 'options.now');

  if (!Number.isFinite(settledTtlMs) || settledTtlMs < 0) {
    throw new TypeError('options.settledTtlMs must be a non-negative number');
  }
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) {
    throw new TypeError('options.maxSessions must be a positive integer');
  }

  const sharedLoginOptions = loginOptions ?? {};

  /** @type {Map<string, LoginSessionEntry>} */
  const sessions = new Map();

  /**
   * Forget settled sessions past their TTL and, if the map is full, the oldest
   * settled entries. Waiting attempts are never dropped: their promise still
   * owns the session.
   */
  function pruneSessions() {
    const cutoff = Number(now()) - settledTtlMs;

    for (const [sessionId, entry] of sessions) {
      if (entry.state !== 'waiting' && entry.settledAt !== null && entry.settledAt < cutoff) {
        sessions.delete(sessionId);
      }
    }

    if (sessions.size < maxSessions) {
      return;
    }

    const settled = [...sessions]
      .filter(([, entry]) => entry.state !== 'waiting')
      .sort((a, b) => a[1].startedAt - b[1].startedAt);

    while (sessions.size >= maxSessions && settled.length > 0) {
      const [sessionId] = /** @type {[string, LoginSessionEntry]} */ (settled.shift());
      sessions.delete(sessionId);
    }
  }

  /**
   * Record the outcome of one login attempt. The resolved token is intentionally
   * ignored: it is already on disk and must never be kept in memory here.
   *
   * @param {string} sessionId
   */
  function trackLogin(sessionId) {
    waitForToken(sessionId, sharedLoginOptions).then(
      () => settle(sessionId, 'ok', null),
      (error) => settle(sessionId, 'error', loginErrorMessage(error)),
    );
  }

  /**
   * @param {string} sessionId
   * @param {'ok' | 'error'} state
   * @param {string | null} message
   */
  function settle(sessionId, state, message) {
    const entry = sessions.get(sessionId);
    // The entry is gone when the user logged out while this attempt was pending.
    if (entry === undefined) {
      return;
    }

    entry.state = state;
    entry.message = message;
    entry.settledAt = Number(now());
  }

  /**
   * Best-effort cancellation: a forgotten or already-settled attempt is a no-op
   * in the login module, and a broken session must not fail the HTTP response.
   *
   * @param {string} sessionId
   */
  async function cancelQuietly(sessionId) {
    try {
      await cancelLogin(sessionId);
    } catch {
      // The attempt is being dropped either way.
    }
  }

  /**
   * Start a QR login attempt and render its URL as an SVG. Fails with
   * `AlreadyLoggedInError` when a token is already stored.
   *
   * @returns {Promise<StartQrLoginResult>}
   */
  async function startQrLogin() {
    if ((await loadToken()) !== null) {
      throw new AlreadyLoggedInError('已登录 Steam，无需重复扫码');
    }

    const { qrUrl, sessionId } = await startLogin(sharedLoginOptions);

    // Register the attempt and attach the token waiter before rendering: the
    // user can scan as soon as Steam returns the URL, and a terminal event must
    // not fire before the waiter subscribed to it.
    pruneSessions();
    sessions.set(sessionId, {
      state: 'waiting',
      message: null,
      startedAt: Number(now()),
      settledAt: null,
    });
    trackLogin(sessionId);

    let qrSvg;
    try {
      qrSvg = await renderQrSvg(qrUrl);
      if (typeof qrSvg !== 'string' || qrSvg === '') {
        throw new Error('QR code renderer returned no SVG');
      }
    } catch (error) {
      // Do not leave a poll-only Steam session behind when the panel never gets
      // a QR code to show.
      sessions.delete(sessionId);
      await cancelQuietly(sessionId);
      throw error;
    }

    return { sessionId, qrUrl, qrSvg };
  }

  /**
   * Report the state of one attempt. An unknown or absent session id resolves
   * to `ok` when a token is stored (for example after a process restart), and
   * to `null` otherwise, which the HTTP layer maps to 404.
   *
   * @param {string | null} [sessionId]
   * @returns {Promise<LoginStatus | null>}
   */
  async function getStatus(sessionId) {
    pruneSessions();

    if (typeof sessionId === 'string' && sessionId !== '') {
      const entry = sessions.get(sessionId);
      if (entry !== undefined) {
        if (entry.state === 'error') {
          return { state: 'error', message: entry.message ?? 'Steam 登录失败' };
        }
        return { state: entry.state };
      }
    }

    // The in-memory attempt is gone (restart or stale browser id); the stored
    // token is the durable answer.
    return (await loadToken()) === null ? null : { state: 'ok' };
  }

  /**
   * Clear the persisted token and forget every tracked attempt. Pending logins
   * are cancelled so they cannot report `ok` after the user logged out.
   *
   * @returns {Promise<{ ok: true }>}
   */
  async function logout() {
    const pending = [...sessions]
      .filter(([, entry]) => entry.state === 'waiting')
      .map(([sessionId]) => sessionId);

    sessions.clear();

    // Cancel first, then clear the token: a cancelled attempt cannot save a
    // token after the store was cleared.
    for (const sessionId of pending) {
      await cancelQuietly(sessionId);
    }
    await clearToken();

    return { ok: true };
  }

  /**
   * Dispatch one request. The caller only sends paths from `LOGIN_PATHS`.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} pathname
   * @param {URLSearchParams} [searchParams]
   * @returns {Promise<boolean>} Whether the pathname was handled.
   */
  async function handle(req, res, pathname, searchParams = new URLSearchParams()) {
    const method = req.method ?? 'GET';

    if (pathname === '/api/login/qr') {
      if (method !== 'POST') {
        sendMethodNotAllowed(res, 'POST');
        return true;
      }

      try {
        sendJson(res, 200, await startQrLogin());
      } catch (error) {
        if (error instanceof AlreadyLoggedInError) {
          sendJson(res, 409, { error: error.message });
          return true;
        }
        throw error;
      }
      return true;
    }

    if (pathname === '/api/login/status') {
      if (method !== 'GET') {
        sendMethodNotAllowed(res, 'GET');
        return true;
      }

      const sessionId = searchParams.get('sessionId') ?? '';
      const status = await getStatus(sessionId);
      if (status === null) {
        sendJson(res, 404, { error: '登录会话不存在' });
        return true;
      }

      sendJson(res, 200, status);
      return true;
    }

    if (pathname === '/api/logout') {
      if (method !== 'POST') {
        sendMethodNotAllowed(res, 'POST');
        return true;
      }

      sendJson(res, 200, await logout());
      return true;
    }

    return false;
  }

  return Object.freeze({ handle, startQrLogin, getStatus, logout });
}
