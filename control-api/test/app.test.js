'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createServer} = require('node:http');
const {createApp} = require('../src/app');

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
