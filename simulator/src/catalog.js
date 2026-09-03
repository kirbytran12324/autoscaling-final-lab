'use strict';

const {Dex} = require('pokemon-showdown');

const dex = Dex.mod('gen9');

function isTournamentSpecies(species) {
  return (
    species.exists &&
    species.num >= 1 &&
    species.num <= 1025 &&
    species.name === species.baseSpecies
  );
}

function listBaseSpecies() {
  return dex.species.all().filter(isTournamentSpecies);
}

function getBaseSpecies(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new TypeError('Species must be a non-empty string');
  }

  const species = dex.species.get(input.trim());

  if (!isTournamentSpecies(species)) {
    throw new RangeError(
      `Species is not in the tournament roster: ${input}`
    );
  }

  return species;
}

function listMetronomeCallableMoves() {
  return dex.moves.all().filter(move =>
    (!move.isNonstandard ||
      move.isNonstandard === 'Unobtainable') &&
    Boolean(move.flags?.metronome)
  );
}

module.exports = {
  listBaseSpecies,
  listMetronomeCallableMoves,
  getBaseSpecies,
};