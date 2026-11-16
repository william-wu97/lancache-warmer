/**
 * Steam QR-code login.
 *
 * `startLogin()` creates a Steam login session for the `SteamClient` platform
 * (only tokens issued for that platform are usable by the CM connection) and
 * returns the URL that should be shown as a QR code. The caller then awaits
 * `waitForToken()` while the user scans and approves the code in the Steam
 * mobile app; once Steam reports `authenticated`, the refresh token is saved
 * through `token-store`.
 *
 * Active sessions live in a module-level `Map` keyed by a random `sessionId`,
 * so several login attempts (multiple browser tabs) never share state. A
 * session is single-use: it leaves the map as soon as it settles or is
 * cancelled.
 *
 * Nothing here logs tokens. Error messages carry only the reason, never a
 * credential value.
 *
 * Tests must never talk to Steam: both the session constructor and the token
 * store call are injectable through `opts`, so tests supply a fake session that
 * emits the events locally.
 */

import { randomUUID } from 'node:crypto';

import { EAuthTokenPlatformType, LoginSession } from 'steam-session';

import { saveToken } from './token-store.js';

/**
 * @typedef {Object} SteamLoginSession
 * @property {() => Promise<{ qrChallengeUrl?: string }>} startWithQR Begins
 *   polling for the QR login and resolves with the URL to encode.
 * @property {(event: string, listener: (...args: any[]) => void) => void} on
 *   Event emitter subscription (`authenticated`, `error`, `timeout`).
 * @property {(event: string, listener: (...args: any[]) => void) => void} removeListener
 * @property {() => boolean} [cancelLoginAttempt] Stops polling.
 * @property {string} [refreshToken] Populated when `authenticated` fires.
 * @property {string | { getSteamID64: () => string }} [steamID] Account id,
 *   populated when `authenticated` fires. `steam-session` exposes a SteamID
 *   instance, whose 64-bit form is what gets persisted.
 */

/**
 * @typedef {Object} TokenRecord
 * @property {string} refreshToken
 * @property {number} savedAt
 * @property {string} steamId
 */

/**
 * @typedef {Object} SaveTokenOptions
 * @property {string} [dataDir]
 */

/**
 * @typedef {(token: TokenRecord, opts: SaveTokenOptions) => Promise<void>} SaveTokenFn
 */

/**
 * @typedef {Object} StartLoginOptions
 * @property {() => SteamLoginSession} [sessionFactory] Session constructor.
 *   Defaults to a real `steam-session` `LoginSession`; tests inject a fake.
 * @property {string} [dataDir] Data directory for the saved token; defaults to
 *   `config.dataDir` inside the token store.
 * @property {SaveTokenFn} [saveToken] Token persistence function; defaults to
 *   `token-store.saveToken`, tests inject a spy.
 * @property {() => number} [now] Clock returning Unix time in milliseconds;
 *   defaults to `Date.now`. Tests inject a fake clock.
 */

/**
 * @typedef {Object} StartLoginResult
 * @property {string} qrUrl URL to render as a QR code (`https://s.team/q/...`).
 * @property {string} sessionId Opaque id used with `waitForToken`/`cancelLogin`.
 */

/**
 * @typedef {Object} WaitForTokenOptions
 * @property {string} [dataDir] Overrides the data directory given to
 *   `startLogin`.
 * @property {SaveTokenFn} [saveToken] Overrides the token store function.
 * @property {() => number} [now] Overrides the clock used for `savedAt`.
 */

/**
 * @typedef {Object} LoginToken
 * @property {string} refreshToken Steam refresh token. Never log this value.
 * @property {string} steamId 64-bit Steam id of the authenticated account.
 */

/**
 * @typedef {Object} LoginSessionEntry
 * @property {SteamLoginSession} session
 * @property {string} [dataDir]
 * @property {SaveTokenFn} [saveToken]
 * @property {() => number} [now]
 * @property {((error: Error) => void) | null} cancelWaiter Rejects a pending
 *   `waitForToken` when the attempt is cancelled.
 * @property {Promise<LoginToken> | null} tokenPromise Shared by concurrent
 *   `waitForToken` calls so a token is saved exactly once.
 */

/**
 * Active login attempts, keyed by `sessionId`.
 *
 * @type {Map<string, LoginSessionEntry>}
 */
const sessions = new Map();

/**
 * @param {SteamLoginSession} session
 * @returns {boolean}
 */
function isAuthenticated(session) {
  try {
    const { refreshToken, steamID } = session;
    return typeof refreshToken === 'string' && refreshToken !== '' && steamID != null;
  } catch {
    // Getters can throw before authentication has populated them.
    return false;
  }
}

/**
 * @param {unknown} steamID
 * @returns {string | null}
 */
function toSteamId(steamID) {
  if (typeof steamID === 'string' && steamID !== '') {
    return steamID;
  }

  if (
    steamID !== null
    && typeof steamID === 'object'
    && typeof (/** @type {{ getSteamID64?: unknown }} */ (steamID).getSteamID64) === 'function'
  ) {
    const value = (/** @type {{ getSteamID64: () => unknown }} */ (steamID)).getSteamID64();
    return typeof value === 'string' && value !== '' ? value : null;
  }

  return null;
}

/**
 * Coerce whatever a listener or factory rejected with into an Error.
 *
 * @param {unknown} error
 * @returns {Error}
 */
function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Read the credentials from an authenticated session and persist them.
 *
 * @param {Object} params
 * @param {SteamLoginSession} params.session
 * @param {SaveTokenFn} params.save
 * @param {string | undefined} params.dataDir
 * @param {() => number} params.now
 * @returns {Promise<LoginToken>}
 */
async function saveAuthenticatedToken({ session, save, dataDir, now }) {
  const { refreshToken } = session;

  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw new Error('Steam login completed without a refresh token');
  }

  const steamId = toSteamId(session.steamID);
  if (steamId === null) {
    throw new Error('Steam login completed without a SteamID');
  }

  await save(
    {
      refreshToken,
      savedAt: Math.floor(now() / 1000),
      steamId,
    },
    { dataDir },
  );

  // The caller needs the token to persist nothing else; returning it lets the
  // web layer report the logged-in account without re-reading the file.
  return { refreshToken, steamId };
}

/**
 * Subscribe to the terminal session events and build the promise returned by
 * `waitForToken`. Only the first settlement counts; listeners are always
 * removed so a cancelled or failed attempt cannot fire later.
 *
 * @param {string} sessionId
 * @param {LoginSessionEntry} entry
 * @param {WaitForTokenOptions} opts
 * @returns {Promise<LoginToken>}
 */
function createTokenPromise(sessionId, entry, opts) {
  const { session } = entry;
  const save = opts.saveToken ?? entry.saveToken ?? saveToken;
  const dataDir = opts.dataDir ?? entry.dataDir;
  const now = opts.now ?? entry.now ?? Date.now;

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      session.removeListener('authenticated', onAuthenticated);
      session.removeListener('error', onError);
      session.removeListener('timeout', onTimeout);
      entry.cancelWaiter = null;
    };

    const rejectOnce = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      sessions.delete(sessionId);
      reject(error);
    };

    const onAuthenticated = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      sessions.delete(sessionId);
      saveAuthenticatedToken({ session, save, dataDir, now }).then(resolve, reject);
    };

    const onError = (error) => {
      const cause = normalizeError(error);
      rejectOnce(new Error(`Steam login failed: ${cause.message}`, { cause }));
    };

    const onTimeout = () => {
      rejectOnce(new Error('Steam login timed out before it was approved'));
    };

    // The event may have fired between `startWithQR()` resolving and the
    // caller calling `waitForToken`; resolve from the current state instead of
    // hanging forever.
    if (isAuthenticated(session)) {
      onAuthenticated();
      return;
    }

    session.on('authenticated', onAuthenticated);
    session.on('error', onError);
    session.on('timeout', onTimeout);

    entry.cancelWaiter = () => rejectOnce(new Error('Steam login was cancelled'));
  });
}

/**
 * Create a real Steam QR login session for the `SteamClient` platform.
 *
 * The platform type is mandatory: without it `steam-session` throws
 * `Unsupported platform type`, and only `SteamClient` tokens can be used for a
 * later CM connection.
 *
 * @returns {SteamLoginSession}
 */
function createSteamSession() {
  return new LoginSession(EAuthTokenPlatformType.SteamClient);
}

/**
 * Start a Steam QR login attempt.
 *
 * Resolves as soon as Steam returned the QR challenge URL; the login is not
 * complete until `waitForToken(sessionId)` resolves.
 *
 * @param {StartLoginOptions} [opts]
 * @returns {Promise<StartLoginResult>}
 */
export async function startLogin(opts = {}) {
  const sessionFactory = opts.sessionFactory ?? createSteamSession;
  const session = sessionFactory();
  const sessionId = randomUUID();

  /** @type {LoginSessionEntry} */
  const entry = {
    session,
    dataDir: opts.dataDir,
    saveToken: opts.saveToken,
    now: opts.now,
    cancelWaiter: null,
    tokenPromise: null,
  };

  // Register before starting so nothing can observe a half-started attempt.
  sessions.set(sessionId, entry);

  try {
    const response = await session.startWithQR();
    const qrUrl = response?.qrChallengeUrl;

    if (typeof qrUrl !== 'string' || qrUrl === '') {
      throw new Error('Steam login did not return a QR code URL');
    }

    return { qrUrl, sessionId };
  } catch (error) {
    sessions.delete(sessionId);
    try {
      session.cancelLoginAttempt?.();
    } catch {
      // Best effort: the attempt already failed, and the caller gets the cause.
    }
    throw normalizeError(error);
  }
}

/**
 * Wait for the user to approve the QR code and save the resulting token.
 *
 * Resolves with `{ refreshToken, steamId }` only after `token-store.saveToken`
 * resolved, so a resolved promise means the credentials are on disk. Rejects on
 * the session's `error` or `timeout` events, when the attempt is cancelled, or
 * when the token cannot be saved. Concurrent calls for the same `sessionId`
 * share one attempt and one save.
 *
 * @param {string} sessionId Value returned by `startLogin`.
 * @param {WaitForTokenOptions} [opts]
 * @returns {Promise<LoginToken>}
 */
export function waitForToken(sessionId, opts = {}) {
  const entry = sessions.get(sessionId);

  if (entry === undefined) {
    return Promise.reject(new Error(`Unknown Steam login session: ${String(sessionId)}`));
  }

  if (entry.tokenPromise === null) {
    entry.tokenPromise = createTokenPromise(sessionId, entry, opts);
  }

  return entry.tokenPromise;
}

/**
 * Cancel a login attempt and forget it.
 *
 * A pending `waitForToken` promise rejects, and the session stops polling.
 * Cancelling an unknown or already-settled `sessionId` is a no-op, so callers
 * can clear state without guarding first.
 *
 * @param {string} sessionId Value returned by `startLogin`.
 * @returns {boolean} Whether an active attempt was cancelled.
 */
export function cancelLogin(sessionId) {
  const entry = sessions.get(sessionId);

  if (entry === undefined) {
    return false;
  }

  sessions.delete(sessionId);

  const { cancelWaiter } = entry;
  entry.cancelWaiter = null;
  // Reject first so the waiter's listeners are removed before the session
  // possibly emits its own terminal event from cancelLoginAttempt().
  if (cancelWaiter !== null) {
    cancelWaiter(new Error('Steam login was cancelled'));
  }

  try {
    entry.session.cancelLoginAttempt?.();
  } catch {
    // Best effort: the entry is forgotten either way.
  }

  return true;
}
