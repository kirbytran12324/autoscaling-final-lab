'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {makeTeam, simulateBattle} = require('../src/battle');

test('team construction fixes gender and happiness deterministically', () => {
  assert.equal(makeTeam('Nidoran-F')[0].gender, 'F');
  assert.equal(makeTeam('Tauros')[0].gender, 'M');
  assert.equal(makeTeam('Snorlax')[0].gender, 'M');
  assert.equal(makeTeam('Magnemite')[0].gender, 'N');

  for (const species of ['Nidoran-F', 'Snorlax', 'Magnemite']) {
    assert.equal(makeTeam(species)[0].happiness, 255);
  }
});

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

test('the pinned battle engine matches the golden deterministic vector', async () => {
  const result = await simulateBattle({
    pokemon1: 'Snorlax',
    pokemon2: 'Clefable',
    seed: [12345, 23456, 34567, 45678],
    maxTurns: 100,
  });

  assert.deepEqual(result, {
    outcome: 'win',
    winnerSide: 'p1',
    winnerSpecies: 'Snorlax',
    turns: 5,
    seed: [12345, 23456, 34567, 45678],
    termination: 'natural',
    protocolHash: '51889bae250badd20a432969b994b9aa9bf12818e4fe90afc60394c4d618f3e9',
    protocolLineCount: 94,
  });
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
