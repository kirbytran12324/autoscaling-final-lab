"use strict";

const assert = require('node:assert/strict');
const {test} = require('node:test');
const {FilesystemArtifactStore} = require('../src/artifact-store');
const {FIXTURE_RUN_ID, createFixtureRoot, removeFixtureRoot} = require('./helpers');

const tick = () => new Promise(resolve => setImmediate(resolve));
function virtualStore(loader) {
  const store = new FilesystemArtifactStore({stateRoot: '/tmp/virtual-artifacts', loadTournamentArtifacts: loader});
  store.assertSafeRunDirectory = async id => `/tmp/virtual-artifacts/runs/${id}`;
  store.canonicalSignature = async () => 'signature';
  store.assertSafeFile = async () => null;
  return store;
}
function artifacts(runId) {
  return {metadata: {runId}, roster: {entrants: []}, failures: [], results: [],
    champion: {champion: {}}, bracket: {rounds: []}, groupByMatchId: new Map()};
}

test('interleaved runs share pending loads and load only one full run at a time', async () => {
  const calls = [];
  const release = [];
  let active = 0;
  let maximum = 0;
  const store = virtualStore(async ({runId}) => {
    calls.push(runId); maximum = Math.max(maximum, ++active);
    await new Promise(resolve => release.push(resolve));
    active--;
    return artifacts(runId);
  });
  const first = store.loadCompletedRun('run-a'); await tick();
  const second = store.loadCompletedRun('run-b');
  const shared = store.loadCompletedRun('run-a'); await tick();
  assert.deepEqual(calls, ['run-a']);
  release.shift()();
  const [a, sameA] = await Promise.all([first, shared]);
  assert.equal(a, sameA); await tick();
  assert.deepEqual(calls, ['run-a', 'run-b']);
  release.shift()(); await second;
  assert.equal(maximum, 1);
  assert.equal(store.pendingLoads.size, 0);
  assert.equal(store.cachedRun.runId, 'run-b');
});

test('failed pending loads are cleared and do not poison the admission queue', async () => {
  let calls = 0;
  const store = virtualStore(async ({runId}) => {
    if (++calls === 1) throw new SyntaxError('malformed');
    return artifacts(runId);
  });
  await assert.rejects(store.loadCompletedRun('run-a'), error => error.status === 422);
  assert.equal(store.pendingLoads.size, 0);
  await store.loadCompletedRun('run-a');
  assert.equal(calls, 2);
});

test('filesystem failures remain outages including wrapped errors and discovery', async t => {
  const root = await createFixtureRoot(); t.after(() => removeFixtureRoot(root));
  const store = new FilesystemArtifactStore({stateRoot: root, loadTournamentArtifacts: async () => {
    const disk = Object.assign(new Error('private disk details'), {code: 'EIO'});
    throw new Error('wrapped artifact failure', {cause: disk});
  }});
  for (const invoke of [() => store.getRun(FIXTURE_RUN_ID), () => store.listRuns()]) {
    await assert.rejects(invoke(), error => error.status === 500 &&
      error.code === 'ARTIFACT_STORE_UNAVAILABLE' && !error.message.includes('private'));
  }
});

test('changed artifact signatures reload rather than serving old results', async () => {
  let signature = 'first'; let loads = 0;
  const store = virtualStore(async ({runId}) => {loads++; return artifacts(runId);});
  store.canonicalSignature = async () => signature;
  const first = await store.loadCompletedRun('run-a');
  assert.equal(await store.loadCompletedRun('run-a'), first);
  signature = 'second';
  assert.notEqual(await store.loadCompletedRun('run-a'), first);
  assert.equal(loads, 2);
});
