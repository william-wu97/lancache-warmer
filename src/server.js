import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import config from './config.js';

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

function sendMethodNotAllowed(res) {
  send(
    res,
    405,
    { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' },
    'Method Not Allowed',
  );
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
 */
async function handleRequest(req, res, webRoot) {
  const method = req.method ?? 'GET';
  const isRead = method === 'GET' || method === 'HEAD';

  let pathname;
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad Request');
    return;
  }

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
 * @param {{ webRoot?: string }} [options]
 * @returns {http.Server}
 */
export function createServer({ webRoot = config.webRoot } = {}) {
  const root = path.resolve(webRoot);

  return http.createServer((req, res) => {
    handleRequest(req, res, root).catch((error) => {
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
