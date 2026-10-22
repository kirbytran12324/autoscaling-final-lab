'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {KubernetesClient} = require('../src/kubernetes');
const {RunManager, SLOT} = require('../src/manager');
const {config, input} = require('./helpers');

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function fixtureClient(reply) {
  const requests = [];
  const client = new KubernetesClient('lab', {host: 'kubernetes.fixture.invalid',
    readFileImpl: async (_path, encoding) => encoding ? 'fixture-only-token' : Buffer.from('fixture-only-ca'),
    requestImpl(options, callback) {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.destroy = error => {
        request.destroyed = true;
        if (error) queueMicrotask(() => request.emit('error', error));
        return request;
      };
      request.end = body => queueMicrotask(() => {
        requests.push({...options, body});
        const result = reply(options, requests.length - 1);
        const response = new EventEmitter();
        response.statusCode = result.status || 200;
        callback(response);
        const chunks = result.chunks || [Buffer.from(JSON.stringify(result.value))];
        for (const chunk of chunks) {
          if (request.destroyed) break;
          response.emit('data', chunk);
        }
        if (!request.destroyed) response.emit('end');
      });
      return request;
    }});
  return {client, requests};
}

test('Kubernetes JSON records and text logs preserve fragmented UTF-8', async () => {
  const seed = 'repeatable-🔥-Tiếng Việt';
  const record = {data: {record: JSON.stringify({input: {...input, seed}})}};
  const log = `Tournament seed: ${seed}\n`;
  const {client} = fixtureClient((_options, index) => {
    const bytes = Buffer.from(index === 0 ? JSON.stringify(record) : log);
    return {chunks: [...bytes].map(byte => Buffer.from([byte]))};
  });
  assert.deepEqual(await client.get('configmaps', 'fixture'), record);
  assert.equal(await client.logs('fixture-pod'), log);
});

test('Kubernetes response limits count bytes and reject oversized fragmented bodies', async () => {
  const accepted = 'a'.repeat(MAX_RESPONSE_BYTES - 4) + '🔥';
  const {client} = fixtureClient((_options, index) => ({chunks: index === 0
    ? [Buffer.from(accepted)] : [Buffer.alloc(MAX_RESPONSE_BYTES - 3, 0x61), Buffer.from('🔥')]}));
  assert.equal(await client.logs('fixture-pod'), accepted);
  await assert.rejects(client.logs('fixture-pod'), {code: 'KUBE_RESPONSE_TOO_LARGE'});
});

test('list aggregates a collection larger than the response cap using encoded continuation tokens', async () => {
  const token = 'next page+/=雪';
  const items = Array.from({length: 6}, (_, index) => ({metadata: {name: `record-${index}`},
    data: {log: 'x'.repeat(900000)}}));
  const {client, requests} = fixtureClient((_options, index) => ({value: {
    apiVersion: 'v1', kind: 'ConfigMapList',
    metadata: {resourceVersion: '99', continue: index === 0 ? token : '', remainingItemCount: 3},
    items: items.slice(index * 3, index * 3 + 3)}}));
  const result = await client.list('configmaps', 'app.kubernetes.io/managed-by=metronome-control');
  assert.equal(Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE_BYTES, true);
  assert.deepEqual(result.items, items);
  assert.deepEqual(result.metadata, {resourceVersion: '99', continue: ''});
  assert.equal(requests.length, 2);
  for (const [index, request] of requests.entries()) {
    const url = new URL(request.path, 'https://fixture.invalid');
    assert.equal(url.pathname, '/api/v1/namespaces/lab/configmaps');
    assert.equal(url.searchParams.get('limit'), '100');
    assert.equal(url.searchParams.get('labelSelector'), 'app.kubernetes.io/managed-by=metronome-control');
    assert.equal(url.searchParams.get('continue'), index === 0 ? null : token);
  }
});

test('oversized later pages restart with smaller pages without retaining partial results', async () => {
  const {client, requests} = fixtureClient(options => {
    const url = new URL(options.path, 'https://fixture.invalid');
    if (url.searchParams.get('limit') === '100') {
      if (url.searchParams.has('continue')) return {chunks: [Buffer.alloc(MAX_RESPONSE_BYTES + 1)]};
      return {value: {metadata: {continue: 'old-snapshot'}, items: [{metadata: {name: 'discarded'}}]}};
    }
    return {value: {metadata: {resourceVersion: 'new', continue: ''}, items: [{metadata: {name: 'retained'}}]}};
  });
  assert.deepEqual((await client.list('configmaps', 'managed=true')).items, [{metadata: {name: 'retained'}}]);
  assert.equal(requests.length, 3);
  const restarted = new URL(requests[2].path, 'https://fixture.invalid');
  assert.equal(restarted.searchParams.get('limit'), '50');
  assert.equal(restarted.searchParams.has('continue'), false);
});

test('an oversized single item stops pagination retries at the minimum page size', async () => {
  const {client, requests} = fixtureClient(() => ({chunks: [Buffer.alloc(MAX_RESPONSE_BYTES + 1)]}));
  await assert.rejects(client.list('configmaps', 'managed=true'), {code: 'KUBE_RESPONSE_TOO_LARGE'});
  assert.deepEqual(requests.map(request => new URL(request.path, 'https://fixture.invalid').searchParams.get('limit')),
    ['100', '50', '25', '12', '6', '3', '1']);
});

test('list errors and repeated continuation tokens never return a partial collection', async () => {
  const failed = fixtureClient((_options, index) => index === 0
    ? {value: {metadata: {continue: 'next'}, items: [{metadata: {name: 'partial'}}]}}
    : {status: 500, value: {message: 'fixture failure'}});
  await assert.rejects(failed.client.list('pods', 'job-name=fixture'), {code: 'KUBERNETES_UNAVAILABLE'});
  assert.equal(failed.requests.length, 2);
  const repeated = fixtureClient(() => ({value: {metadata: {continue: 'same'}, items: []}}));
  await assert.rejects(repeated.client.list('pods', 'job-name=fixture'), /repeated a continuation token/);
  assert.equal(repeated.requests.length, 2);
});

test('manager listing preserves active records and excludes the singleton slot across pages', async () => {
  const old = {input: {...input, runId: 'completed'}, phase: 'completed', createdAt: '2026-10-20T00:00:00Z'};
  const active = {input: {...input, runId: 'active'}, phase: 'running', createdAt: '2026-10-22T00:00:00Z'};
  let manager;
  const {client} = fixtureClient((_options, index) => ({value: {metadata: {continue: index === 0 ? 'next' : ''},
    items: index === 0 ? [manager.resource('mt-run-completed', old), manager.resource(SLOT, active)]
      : [manager.resource('mt-run-active', active)]}}));
  manager = new RunManager(client, config);
  assert.deepEqual((await manager.list()).map(run => ({runId: run.runId, phase: run.phase, archiveReady: run.archiveReady})),
    [{runId: 'active', phase: 'running', archiveReady: false}, {runId: 'completed', phase: 'completed', archiveReady: true}]);
});
