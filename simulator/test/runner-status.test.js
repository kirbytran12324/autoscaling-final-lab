'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {mkdir, writeFile} = require('node:fs/promises');
const {createServer} = require('node:net');
const {join} = require('node:path');
const {startStatusServer} = require('../src/runner/status-server');
const {createStateRoot} = require('../test-support/runner');

test('internal snapshot requires its own token and tolerates missing early artifacts', async t => {
  const stateRoot = await createStateRoot(t);
  const temporary = createServer();
  await new Promise(resolve => temporary.listen(0, '127.0.0.1', resolve));
  const port = temporary.address().port;
  await new Promise(resolve => temporary.close(resolve));
  const token = 's'.repeat(32);
  const state = {stopping: false, events: [{type: 'battle-accepted'}]};
  const server = await startStatusServer({configuration: {stateRoot, identity: {runId: 'sample'}},
    token, port, host: '127.0.0.1', state});
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${port}/status`;
  assert.equal((await fetch(url)).status, 401);
  const headers = {authorization: `Bearer ${token}`};
  const initial = await (await fetch(url, {headers})).json();
  assert.equal(initial.checkpoint, null); assert.equal(initial.runId, 'sample');
  await mkdir(join(stateRoot, 'runs', 'sample'), {recursive: true});
  await writeFile(join(stateRoot, 'runs', 'sample', 'checkpoint.json'), JSON.stringify({acceptedResultCount: 4}));
  const response = await fetch(url, {headers});
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).checkpoint.acceptedResultCount, 4);
  assert.equal((await fetch(url + '?run=other', {headers})).status, 404);
});
