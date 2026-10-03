'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {setTimeout: delay} = require('node:timers/promises');
const {ReplayService, createReplayClient, MAX_LOG_BYTES} = require('../src/replays');
const {ApiError} = require('../src/errors');
const {DETERMINISTIC_RESULT_FIELDS} = require('../../simulator/src/deterministic-result');
const {FilesystemArtifactStore} = require('../src/artifact-store');
const {createFixtureRoot, removeFixtureRoot, FIXTURE_RUN_ID} = require('./helpers');
const {createApp} = require('../src/app');
const {createServer} = require('../../simulator/src/server');

const original = {matchId: 'group-A-000001', pokemon1: 'Snorlax', pokemon2: 'Blastoise',
  seed: [48906, 52980, 4687, 23748], simulatorVersion: 'pokemon-showdown@0.11.11',
  outcome: 'win', winnerSide: 'p2', winnerSpecies: 'Blastoise', turns: 4, termination: 'natural',
  protocolHash: '6284259b96419e5536b3bd46db3bdfad37f3830f82975d874a189775019d4d41'};
const log = '|gametype|singles\n|turn|4\n|win|p2\n';
const logger = {info() {}, error() {}};
function setup(options = {}) {
  let match = {...original}; let calls = 0;
  const store = {async getReplayContext(runId, matchId) {
    return {match: {...match, matchId}, rulesVersion: 'metronome-singles-v1', simulatorVersion: original.simulatorVersion};
  }};
  const generate = async input => {calls++; return {result: {...match, matchId: input.matchId}, log};};
  return {service: new ReplayService({store, generate, logger, ...options}), store,
    calls: () => calls, change: value => {match = {...match, ...value};}};
}

test('cache reuses verified data, expires, and invalidates changed canonical records', async () => {
  let time = 0;
  const {service, calls, change} = setup({now: () => time});
  const first = await service.getReplay('run', original.matchId);
  assert.equal(first.replay.verified, true);
  assert.deepEqual(await service.getReplay('run', original.matchId), first);
  assert.equal(calls(), 1);
  time = 300001;
  await service.getReplay('run', original.matchId);
  assert.equal(calls(), 2);
  change({turns: 5});
  await service.getReplay('run', original.matchId);
  assert.equal(calls(), 3);
});

test('cache evicts by entry count and byte budget', async () => {
  const {service, calls} = setup({maxEntries: 1});
  await service.getReplay('run', 'a'); await service.getReplay('run', 'b'); await service.getReplay('run', 'a');
  assert.equal(calls(), 3); assert.equal(service.cache.size, 1);
  const bounded = setup({maxBytes: 1});
  await bounded.service.getReplay('run', 'a');
  assert.equal(bounded.service.cacheBytes, 0);
  assert.equal(bounded.service.cache.size, 0);
  const byteEviction = setup({maxBytes: 500});
  await byteEviction.service.getReplay('run', 'a'); await byteEviction.service.getReplay('run', 'b');
  assert.equal(byteEviction.service.cache.size, 1);
  await byteEviction.service.getReplay('run', 'a');
  assert.equal(byteEviction.calls(), 3);
  assert.ok(byteEviction.service.cacheBytes <= 500);
});

test('every deterministic result mismatch blocks playback and remains uncached', async () => {
  for (const field of DETERMINISTIC_RESULT_FIELDS) {
    const response = {...original, [field]: field === 'seed' ? [1, 2, 3, 4] : null};
    const {service} = setup({generate: async () => ({result: response, log})});
    await assert.rejects(service.getReplay('run', original.matchId), error => error.status === 409, field);
    assert.equal(service.cache.size, 0);
    assert.equal(service.pending.size, 0);
  }
});

test('unsupported artifacts fail before contacting the simulator', async () => {
  const state = setup();
  state.change({simulatorVersion: 'pokemon-showdown@old'});
  await assert.rejects(state.service.getReplay('run', 'a'), error => error.status === 422);
  assert.equal(state.calls(), 0);
  const unsupported = setup({store: {async getReplayContext() {
    return {match: original, rulesVersion: 'unknown', simulatorVersion: original.simulatorVersion};
  }}});
  await assert.rejects(unsupported.service.getReplay('run', 'a'), error => error.code === 'REPLAY_UNSUPPORTED');
});

test('identical pending requests coalesce and distinct work is bounded', async () => {
  const releases = [];
  let calls = 0;
  const {service} = setup({generate: input => {calls++; return new Promise(resolve => {
    releases.push(() => resolve({result: {...original, matchId: input.matchId}, log}));
  });}});
  const first = service.getReplay('run', 'a'); const same = service.getReplay('run', 'a');
  const second = service.getReplay('run', 'b');
  await delay(0);
  assert.equal(calls, 2);
  await assert.rejects(service.getReplay('run', 'c'), error => error.code === 'REPLAY_BUSY');
  releases.forEach(release => release());
  assert.deepEqual(await first, await same); await second;
  assert.equal(service.pending.size, 0);
});

test('bad, private, oversized, and failed responses are never cached', async () => {
  for (const payload of [{}, {result: original, log: ''},
    {result: original, log: '|split|p1\nprivate\npublic'},
    {result: original, log: 'x'.repeat(MAX_LOG_BYTES + 1)}]) {
    const {service} = setup({generate: async () => payload});
    await assert.rejects(service.getReplay('run', original.matchId), error => error.status === 502);
    assert.equal(service.cache.size, 0);
  }
  const {service} = setup({generate: async () => {throw new Error('private host address');}});
  await assert.rejects(service.getReplay('run', 'a'), error => error.code === 'REPLAY_UNAVAILABLE' && !error.message.includes('private'));
});

test('replay client bounds responses and maps timeout and unavailability', async t => {
  const unavailable = createReplayClient({fetchImpl: async () => {throw new Error('connection refused');}});
  await assert.rejects(unavailable(original), error => error.status === 503);
  const unsupported = createReplayClient({fetchImpl: async () => new Response('{}', {status: 422})});
  await assert.rejects(unsupported(original), error => error.status === 422);
  const huge = createReplayClient({fetchImpl: async () => new Response('x'.repeat(2 * MAX_LOG_BYTES + 1))});
  await assert.rejects(huge(original), error => error.code === 'REPLAY_TOO_LARGE');
  const hold = setTimeout(() => {}, 1000); t.after(() => clearTimeout(hold));
  const timeout = createReplayClient({timeoutMs: 5, fetchImpl: async (url, {signal}) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {once: true});
  })});
  await assert.rejects(timeout(original), error => error.status === 504);
  assert.throws(() => createReplayClient({baseUrl: 'file:///private'}), /HTTP/);
});

test('the public route uses canonical artifacts and a real simulator without modifying evidence', async t => {
  const root = await createFixtureRoot(); t.after(() => removeFixtureRoot(root));
  const store = new FilesystemArtifactStore({stateRoot: root});
  const simulator = createServer();
  await new Promise(resolve => simulator.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => simulator.close(resolve)));
  const replays = new ReplayService({store, logger, generate: createReplayClient({baseUrl: `http://127.0.0.1:${simulator.address().port}`})});
  const before = await store.getReplayContext(FIXTURE_RUN_ID, original.matchId);
  const app = createApp({store, replays, logger});
  async function request(suffix = '', method = 'GET') {
    let status, body;
    await app({method, url: `/api/runs/${FIXTURE_RUN_ID}/matches/${original.matchId}/replay${suffix}`}, {
      writeHead(value) {status = value;}, end(value) {body = JSON.parse(value);},
    });
    return {status, body};
  }
  const first = await request(); assert.equal(first.status, 200);
  assert.equal(first.body.replay.protocolHash, original.protocolHash);
  assert.match(first.body.replay.log, /\|win\|p2/);
  assert.deepEqual(await store.getReplayContext(FIXTURE_RUN_ID, original.matchId), before);
  assert.equal((await request('?seed=1')).status, 400);
  assert.equal((await request('', 'POST')).status, 405);
  await assert.rejects(replays.getReplay(FIXTURE_RUN_ID, 'missing-match'), error => error.status === 404);
});
