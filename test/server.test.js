import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import config from '../src/config.js';
import { createServer } from '../src/server.js';

let server;
let baseUrl;
let webRoot;

before(async () => {
  // Use a throwaway web root so tests never depend on files checked into web/.
  webRoot = await mkdtemp(path.join(os.tmpdir(), 'lancache-warmer-web-'));
  await writeFile(
    path.join(webRoot, 'index.html'),
    '<!doctype html><title>lancache-warmer</title>',
  );
  await writeFile(path.join(webRoot, 'app.js'), 'console.log("ok");\n');

  server = createServer({ webRoot });
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(webRoot, { recursive: true, force: true });
});

test('GET /health returns the health payload', async () => {
  const response = await fetch(`${baseUrl}/health`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await response.json(), { ok: true, version: '0.1.0' });
});

test('GET / serves index.html from the web root', async () => {
  const response = await fetch(`${baseUrl}/`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.match(await response.text(), /lancache-warmer/);
});

test('GET /app.js serves static assets with a JavaScript content type', async () => {
  const response = await fetch(`${baseUrl}/app.js`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/javascript/);
  assert.equal(await response.text(), 'console.log("ok");\n');
});

test('HEAD /health returns headers without a body', async () => {
  const response = await fetch(`${baseUrl}/health`, { method: 'HEAD' });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

test('POST /health is rejected', async () => {
  const response = await fetch(`${baseUrl}/health`, { method: 'POST' });

  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});

test('unknown paths return 404', async () => {
  const response = await fetch(`${baseUrl}/does-not-exist`);

  assert.equal(response.status, 404);
});

test('GET /api/task returns an idle snapshot before the first task', async () => {
  const response = await fetch(`${baseUrl}/api/task`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await response.json(), {
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
  });
});

test('POST /api/prefill rejects invalid appIds with 400', async () => {
  const response = await fetch(`${baseUrl}/api/prefill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appIds: ['413150'] }),
  });

  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.match((await response.json()).error, /appIds/);
});

test('POST /api/prefill rejects an unparseable body with 400', async () => {
  const response = await fetch(`${baseUrl}/api/prefill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json',
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /JSON/);
});

test('encoded path traversal does not escape the web root', async () => {
  const response = await fetch(`${baseUrl}/%2e%2e%2fpackage.json`);

  assert.equal(response.status, 404);
});

test('the default web root is the repository web directory', async () => {
  assert.equal(path.basename(config.webRoot), 'web');
  assert.equal((await stat(config.webRoot)).isDirectory(), true);
});
