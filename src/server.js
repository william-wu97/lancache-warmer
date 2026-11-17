import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createLoginRoutes, LOGIN_PATHS } from './api/login-routes.js';
import {
  createTaskRunner,
  NotLoggedInError,
  TaskConflictError,
  TaskValidationError,
} from './api/task-runner.js';
import config from './config.js';
import { scanCache } from './library/cache.js';

// Paths handled by the API router. Anything else below /api/ is not an API
// route and falls through to the static handler.
const API_PATHS = new Set([
  '/api/prefill',
  '/api/logs',
  '/api/task',
  '/api/cancel',
  '/api/cache',
]);

// appIds requests are tiny; a larger body is always a mistake.
const MAX_JSON_BODY_BYTES = 64 * 1024;

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const HEALTH_BODY = JSON.stringify({ ok: true, version: config.version });

/**
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {Record<string, string | number>} headers
 * @param {string | Buffer} [body]
 */
function send(res, statusCode, headers, body = '') {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(statusCode, {
    'Content-Length': payload.length,
    ...headers,
  });
  res.end(payload);
}

function sendNotFound(res) {
  send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found');
}

/**
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {unknown} payload
 */
function sendJson(res, statusCode, payload) {
  send(
    res,
    statusCode,
    {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    JSON.stringify(payload),
  );
}

/**
 * @param {http.ServerResponse} res
 * @param {string} [allow]
 */
function sendMethodNotAllowed(res, allow = 'GET, HEAD') {
  send(
    res,
    405,
    { Allow: allow, 'Content-Type': 'text/plain; charset=utf-8' },
    'Method Not Allowed',
  );
}

/**
 * A request body that cannot be accepted. Carries the status code the API
 * layer should answer with.
 */
class RequestBodyError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} message
   */
  constructor(statusCode, message) {
    super(message);
    this.name = 'RequestBodyError';
    this.statusCode = statusCode;
  }
}

/**
 * Read and parse a JSON request body. The payload is small, so the whole body
 * is collected before parsing; the size limit prevents an unbounded read.
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<unknown>}
 */
async function readJsonBody(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new RequestBodyError(413, '请求体过大');
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') {
    throw new RequestBodyError(400, '请求体必须是非空 JSON');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new RequestBodyError(400, '请求体不是合法 JSON');
  }
}

/**
 * Stream log lines as Server-Sent Events. `subscribe()` replays the buffered
 * history before registering the listener, so the client sees the recent lines
 * followed by every later line. The subscription is dropped as soon as the
 * response closes, which covers a client disconnect.
 *
 * @param {http.ServerResponse} res
 * @param {ReturnType<typeof createTaskRunner>} runner
 */
function handleLogStream(res, runner) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering so lines arrive as they are produced.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let closed = false;
  const unsubscribe = runner.subscribe((entry) => {
    if (closed || res.writableEnded) {
      return;
    }

    try {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    } catch {
      // The connection died mid-write; the close handler removes the listener.
    }
  });

  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    unsubscribe();
  };

  res.on('close', cleanup);
  res.on('error', cleanup);
}

/**
 * Dispatch one of the exact API paths. Unknown methods get a 405 with the
 * allowed verb; runner errors are translated onto the documented status codes.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} pathname
 * @param {ReturnType<typeof createTaskRunner>} runner
 */
async function handleApiRequest(req, res, pathname, runner) {
  const method = req.method ?? 'GET';

  if (pathname === '/api/prefill') {
    if (method !== 'POST') {
      sendMethodNotAllowed(res, 'POST');
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      if (error instanceof RequestBodyError) {
        sendJson(res, error.statusCode, { error: error.message });
        return;
      }
      throw error;
    }

    try {
      const appIds = body !== null && typeof body === 'object'
        ? Reflect.get(body, 'appIds')
        : undefined;
      const task = await runner.start(appIds);
      sendJson(res, 202, task);
    } catch (error) {
      if (error instanceof TaskValidationError) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      if (error instanceof TaskConflictError) {
        sendJson(res, 409, { error: error.message });
        return;
      }
      if (error instanceof NotLoggedInError) {
        sendJson(res, 428, { error: error.message });
        return;
      }
      throw error;
    }
    return;
  }

  if (pathname === '/api/task') {
    if (method !== 'GET') {
      sendMethodNotAllowed(res, 'GET');
      return;
    }
    sendJson(res, 200, runner.getSnapshot());
    return;
  }

  if (pathname === '/api/cache') {
    if (method !== 'GET') {
      sendMethodNotAllowed(res, 'GET');
      return;
    }

    // Read-only walk of the lancache volume. Scanning a multi-GB tree takes a
    // moment, so this is deliberately a separate endpoint the panel calls once
    // on load instead of folding it into every /api/task poll.
    try {
      sendJson(res, 200, await scanCache());
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  if (pathname === '/api/cancel') {
    if (method !== 'POST') {
      sendMethodNotAllowed(res, 'POST');
      return;
    }

    const cancelled = runner.cancel();
    sendJson(res, 200, { cancelled, state: runner.getSnapshot().state });
    return;
  }

  if (pathname === '/api/logs') {
    if (method !== 'GET') {
      sendMethodNotAllowed(res, 'GET');
      return;
    }
    handleLogStream(res, runner);
    return;
  }
}

/**
 * Translate a URL pathname into a file inside the web root, or return null when
 * the path is malformed or would escape the root.
 *
 * @param {string} webRoot
 * @param {string} pathname
 * @returns {string | null}
 */
function resolveStaticPath(webRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  // A NUL byte is never valid in a path and can truncate it in native calls.
  if (decoded.includes('\0')) {
    return null;
  }

  const relative = (decoded === '/' ? 'index.html' : decoded).replace(/^\/+/, '');
  const filePath = path.resolve(webRoot, relative);
  const isInsideRoot =
    filePath === webRoot || filePath.startsWith(webRoot + path.sep);

  return isInsideRoot ? filePath : null;
}

/**
 * @param {http.ServerResponse} res
 * @param {string} filePath
 * @param {import('node:fs').Stats} stats
 * @param {boolean} headOnly
 */
function streamFile(res, filePath, stats, headOnly) {
  res.writeHead(200, {
    'Content-Type': MIME_TYPES.get(path.extname(filePath).toLowerCase())
      ?? 'application/octet-stream',
    'Content-Length': stats.size,
    'Cache-Control': 'no-cache',
  });

  if (headOnly) {
    res.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/**
 * @param {http.ServerResponse} res
 * @param {string} filePath
 * @param {boolean} headOnly
 */
async function serveFile(res, filePath, headOnly) {
  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    sendNotFound(res);
    return;
  }

  if (stats.isDirectory()) {
    await serveFile(res, path.join(filePath, 'index.html'), headOnly);
    return;
  }

  if (!stats.isFile()) {
    sendNotFound(res);
    return;
  }

  streamFile(res, filePath, stats, headOnly);
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} webRoot
 * @param {ReturnType<typeof createTaskRunner>} runner
 * @param {ReturnType<typeof createLoginRoutes>} loginRoutes
 */
async function handleRequest(req, res, webRoot, runner, loginRoutes) {
  const method = req.method ?? 'GET';
  const isRead = method === 'GET' || method === 'HEAD';

  let url;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad Request');
    return;
  }
  const pathname = url.pathname;

  if (pathname === '/health') {
    if (!isRead) {
      sendMethodNotAllowed(res);
      return;
    }

    const body = Buffer.from(HEALTH_BODY);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(method === 'HEAD' ? undefined : body);
    return;
  }

  if (LOGIN_PATHS.has(pathname)) {
    await loginRoutes.handle(req, res, pathname, url.searchParams);
    return;
  }

  if (API_PATHS.has(pathname)) {
    await handleApiRequest(req, res, pathname, runner);
    return;
  }

  if (!isRead) {
    sendMethodNotAllowed(res);
    return;
  }

  const filePath = resolveStaticPath(webRoot, pathname);
  if (filePath === null) {
    sendNotFound(res);
    return;
  }

  await serveFile(res, filePath, method === 'HEAD');
}

/**
 * Create the HTTP server without binding a port, so tests can listen on an
 * ephemeral port.
 *
 * @param {{
 *   webRoot?: string,
 *   taskRunner?: ReturnType<typeof createTaskRunner>,
 *   loginRoutes?: ReturnType<typeof createLoginRoutes>,
 * }} [options]
 * @returns {http.Server}
 */
export function createServer({
  webRoot = config.webRoot,
  taskRunner = createTaskRunner(),
  loginRoutes = createLoginRoutes(),
} = {}) {
  const root = path.resolve(webRoot);

  return http.createServer((req, res) => {
    handleRequest(req, res, root, taskRunner, loginRoutes).catch((error) => {
      console.error('Request failed:', error);
      if (res.headersSent) {
        res.destroy();
      } else {
        send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Internal Server Error');
      }
    });
  });
}

const isMain =
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const server = createServer();

  const onListening = () => {
    const { port } = server.address();
    const host = config.host ?? 'localhost';
    console.log(`lancache-warmer listening on http://${host}:${port}`);
  };

  if (config.host) {
    server.listen(config.port, config.host, onListening);
  } else {
    server.listen(config.port, onListening);
  }

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
