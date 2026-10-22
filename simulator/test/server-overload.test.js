'use strict';

const assert = require('node:assert/strict');
const {setTimeout: sleep} = require('node:timers/promises');
const {test} = require('node:test');
const {createServer} = require('../src/server');

test('battle and replay share capacity while health and rejection remain available', async t => {
  const started = [];
  const gates = new Map();
  async function simulate(input) {
    started.push(input.matchId);
    await new Promise(resolve => gates.set(input.matchId, resolve));
    return {outcome: 'tie', winnerSide: null, winnerSpecies: null, turns: 100,
      termination: 'turn-cap', protocolHash: 'a'.repeat(64), seed: input.seed};
  }
  const server = createServer({maxConcurrentBattles: 1, maxQueuedBattles: 1,
    simulateBattleImpl: simulate,
    simulateReplayImpl: async input => ({result: await simulate(input), log: '|tie|\n'})});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const finish of gates.values()) finish();
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const input = {pokemon1: 'Snorlax', pokemon2: 'Clefable', seed: [1, 2, 3, 4],
    maxTurns: 100, rulesVersion: 'metronome-singles-v1',
    simulatorVersion: 'pokemon-showdown@0.11.11'};
  const post = (matchId, route = 'battles', signal) => fetch(`${base}/v1/${route}`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({...input, matchId}), signal});
  async function until(predicate) {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await sleep(10); }
    assert.fail('Timed out waiting for admission state');
  }
  const first = post('first');
  await until(() => gates.has('first'));
  const controller = new AbortController();
  const cancelled = post('cancelled', 'battles/replay', controller.signal).catch(error => error);
  await until(async () => (await fetch(`${base}/health/ready`)).status === 503);
  assert.deepEqual(started, ['first']);
  const busy = await post('excess');
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('retry-after'), '1');
  assert.equal((await busy.json()).error.code, 'SIMULATOR_BUSY');
  assert.equal((await fetch(`${base}/health/live`)).status, 200);
  controller.abort();
  assert.equal((await cancelled).name, 'AbortError');
  await until(async () => (await fetch(`${base}/health/ready`)).status === 200);
  const replay = post('replay', 'battles/replay');
  await until(async () => (await fetch(`${base}/health/ready`)).status === 503);
  gates.get('first')();
  assert.equal((await first).status, 200);
  await until(() => gates.has('replay'));
  gates.get('replay')();
  assert.equal((await replay).status, 200);
  assert.equal((await fetch(`${base}/health/ready`)).status, 200);
  assert.deepEqual(started, ['first', 'replay']);
});
