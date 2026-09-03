'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {simulateBattle} = require('../src/battle');

test('identical battle inputs produce identical results', async () => {
  const input = {
    pokemon1: 'Snorlax',
    pokemon2: 'Clefable',
    seed: [12345, 23456, 34567, 45678],
  };

  const first = await simulateBattle(input);
  const second = await simulateBattle(input);

  assert.deepEqual(first, second);
  assert.ok(first.turns > 0);
  assert.ok(first.winnerSide === 'p1' ||
            first.winnerSide === 'p2' ||
            first.winnerSide === null);
  assert.match(first.protocolHash, /^[a-f0-9]{64}$/);
  assert.ok(first.protocolLineCount > 0);
});

test('a surviving battle is tied after the configured turn cap', async () => {
  const result = await simulateBattle({
    pokemon1: 'Snorlax',
    pokemon2: 'Clefable',
    seed: [32594, 816, 150, 486],
    maxTurns: 1,
  });

  assert.equal(result.outcome, 'tie');
  assert.equal(result.winnerSide, null);
  assert.equal(result.turns, 1);
  assert.equal(result.termination, 'turn-cap');
});