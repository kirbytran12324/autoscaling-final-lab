'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  listBaseSpecies,
  listMetronomeCallableMoves,
  getBaseSpecies,
} = require('../src/catalog');

test('the tournament contains all 1,025 base species', () => {
  const roster = listBaseSpecies();

  assert.equal(roster.length, 1025);
  assert.equal(roster[0].name, 'Bulbasaur');
  assert.equal(roster.at(-1).name, 'Pecharunt');
});

test('the engine exposes 581 Metronome-callable moves', () => {
  const moves = listMetronomeCallableMoves();

  assert.equal(moves.length, 581);
  assert.ok(moves.every(move => move.flags.metronome));
});

test('invalid and alternate-form species are rejected', () => {
  assert.throws(
    () => getBaseSpecies('MissingNo'),
    RangeError
  );

  assert.throws(
    () => getBaseSpecies('Charizard-Mega-X'),
    RangeError
  );

  assert.throws(
    () => getBaseSpecies(''),
    TypeError
  );

  assert.equal(getBaseSpecies('Snorlax').name, 'Snorlax');
});