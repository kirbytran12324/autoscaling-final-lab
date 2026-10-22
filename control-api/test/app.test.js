'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createServer} = require('node:http');
const {Readable} = require('node:stream');
const {createApp} = require('../src/app');
const {validateInput} = require('../src/config');

async function createFromChunks(chunks, manager) {
  const request = Readable.from(chunks);
  Object.assign(request, {url: '/api/control/runs', method: 'POST',
    headers: {authorization: `Bearer ${'a'.repeat(32)}`, 'content-type': 'application/json'},
    socket: {remoteAddress: '127.0.0.1'}});
  let status, value;
  const app = createApp({manager, token: 'a'.repeat(32), maxConcurrency: 16});
  await app(request, {writeHead(code) { status = code; }, end(body) { value = JSON.parse(body); }});
  return {status, value};
}

test('creation preserves a Unicode seed fragmented across every UTF-8 byte', async () => {
  const input = {runId: 'unicode-seed', mode: 'sample', seed: 'repeatable-🔥-Tiếng Việt', concurrency: 1};
  const body = Buffer.from(JSON.stringify(input));
  const result = await createFromChunks([...body].map(byte => Buffer.from([byte])),
    {create: async value => validateInput(value)});
  assert.equal(result.status, 202);
  assert.deepEqual(result.value.run, input);
});

test('fragmented creation bodies enforce the byte limit before invoking the manager', async () => {
  const input = {runId: 'unicode-limit', mode: 'sample', seed: '🔥', concurrency: 1};
  const body = Buffer.from(JSON.stringify(input));
  const padded = Buffer.concat([body, Buffer.alloc(4096 - body.length, 0x20)]);
  let calls = 0;
  const manager = {create: async value => { calls++; return validateInput(value); }};
  assert.equal((await createFromChunks([padded.subarray(0, 41), padded.subarray(41)], manager)).status, 202);
  const oversized = Buffer.from(JSON.stringify({...input, seed: '🔥'.repeat(1100)}));
  assert.ok(oversized.length > 4096 && oversized.toString('utf8').length < 4096);
  const result = await createFromChunks([oversized.subarray(0, 2049), oversized.subarray(2049)], manager);
  assert.equal(result.status, 413);
  assert.equal(result.value.error.code, 'BODY_TOO_LARGE');
  assert.equal(calls, 1);
});

test('HTTP contract protects reads/writes, validates JSON/body size/origin and provides health', async t => {
  let calls = 0;
  const manager = {list: async () => { calls++; return []; }, create: async input => {calls++; return input;}};
  const server = createServer(createApp({manager, token: 'a'.repeat(32), maxConcurrency: 16}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/health/live')).status, 200);
  assert.equal((await fetch(base + '/api/control/runs')).status, 401);
  assert.equal(calls, 0);
  const headers = {authorization: 'Bearer ' + 'a'.repeat(32), 'content-type': 'application/json'};
  assert.equal((await fetch(base + '/api/control/runs', {headers})).status, 200);
  assert.equal((await fetch(base + '/api/control/runs', {method: 'POST', headers, body: '{'})).status, 400);
  assert.equal((await fetch(base + '/api/control/runs', {method: 'POST', headers, body: 'x'.repeat(5000)})).status, 413);
  assert.equal((await fetch(base + '/api/control/runs', {headers: {...headers, origin: 'https://attacker.invalid'}})).status, 403);
  const result = await fetch(base + '/api/control/runs', {method: 'POST', headers, body: JSON.stringify({runId: 'sample'})});
  assert.equal(result.status, 202);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal((await result.json()).run.runId, 'sample');
});
