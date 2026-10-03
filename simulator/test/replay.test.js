'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {simulateBattle, simulateBattleReplay} = require('../src/battle');
const {createServer} = require('../src/server');
const {BattleStream} = require('pokemon-showdown');
const {extractChannelMessages} = require('pokemon-showdown/dist/sim/battle');
const input = {pokemon1: 'Snorlax', pokemon2: 'Clefable', seed: [12345, 23456, 34567, 45678], maxTurns: 100};

test('replay capture preserves the golden result and strips spectator-private lines', async () => {
  const plain = await simulateBattle(input);
  const replay = await simulateBattleReplay(input);
  assert.deepEqual(replay.result, plain);
  assert.equal(replay.result.protocolHash, '51889bae250badd20a432969b994b9aa9bf12818e4fe90afc60394c4d618f3e9');
  assert.match(replay.log, /^\|gametype\|singles/m);
  assert.match(replay.log, /^\|win\|p1$/m);
  assert.doesNotMatch(replay.log, /^\|(split|request|t:)\|/m);
  assert.equal(Object.hasOwn(plain, 'log'), false);
});

test('turn cap replay ends with a tie while retaining the original protocol hash', async () => {
  const capped = {...input, seed: [32594, 816, 150, 486], maxTurns: 1};
  const {result, log} = await simulateBattleReplay(capped);
  assert.deepEqual(result, await simulateBattle(capped));
  assert.equal(result.termination, 'turn-cap');
  assert.equal(result.turns, 1);
  assert.match(log, /^\|tie\|?$/m);
});

test('replay capture has a finite byte limit', async () => {
  await assert.rejects(simulateBattleReplay(input, {maxReplayBytes: 10}), /byte limit/);
});

test('the pinned spectator extractor chooses public split lines', () => {
  assert.deepEqual(extractChannelMessages('|split|p1\nprivate-p1\npublic\n|turn|1', [0])[0], ['public', '|turn|1']);
});

test('natural tie end records remain distinct from the lab turn cap', async () => {
  // Force the upstream engine's tie command after a completed turn to exercise
  // its real update/end records, without triggering the lab's cap handling.
  const original = BattleStream.prototype._writeLine;
  let moves = 0;
  BattleStream.prototype._writeLine = function (type, message) {
    if (type === 'p1' && message === 'move 1' && ++moves === 2) {
      return original.call(this, 'forcetie', '');
    }
    return original.call(this, type, message);
  };
  try {
    const {result, log} = await simulateBattleReplay(input);
    assert.equal(result.outcome, 'tie'); assert.equal(result.winnerSide, null);
    assert.equal(result.winnerSpecies, null); assert.equal(result.termination, 'natural');
    assert.equal(result.turns, 2); assert.match(log, /^\|tie\|?$/m);
  } finally {BattleStream.prototype._writeLine = original;}
});

test('internal replay route regenerates fixed rules and rejects unsupported requests', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/v1/battles/replay`;
  const body = {...input, matchId: 'group-A-000001', rulesVersion: 'metronome-singles-v1',
    simulatorVersion: 'pokemon-showdown@0.11.11'};
  const request = value => fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(value)});
  const response = await request(body);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.result.matchId, body.matchId);
  assert.equal(payload.result.simulatorVersion, body.simulatorVersion);
  assert.equal(payload.result.protocolHash, (await simulateBattle(input)).protocolHash);
  assert.match(payload.log, /\|win\|p1/);
  for (const invalid of [{...body, rulesVersion: 'v2'}, {...body, simulatorVersion: 'old'}, {...body, maxTurns: 1}]) {
    const bad = await request(invalid);
    assert.equal(bad.status, 422);
    assert.equal((await bad.json()).error.code, 'REPLAY_UNSUPPORTED');
  }
  assert.equal((await request({...body, seed: [-1]})).status, 400);
  assert.equal((await fetch(url, {method: 'POST', body: '{}'})).status, 415);
});
