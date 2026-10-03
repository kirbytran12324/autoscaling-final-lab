'use strict';

const {PRNG} = require('pokemon-showdown');
const {getBaseSpecies, listBaseSpecies} = require('../catalog');
const {deriveShowdownSeed} = require('./seeding');
const {GROUP_NAMES} = require('./rules');

function validateAndSortRoster(species, expectedCount) {
  if (species.length !== expectedCount) {
    throw new RangeError(
      `Roster must contain exactly ${expectedCount} species`
    );
  }

  const speciesIds = new Set();
  const nationalDexNumbers = new Set();

  for (const entry of species) {
    if (speciesIds.has(entry.id)) {
      throw new RangeError(
        `Roster contains duplicate species: ${entry.name}`
      );
    }

    if (nationalDexNumbers.has(entry.num)) {
      throw new RangeError(
        `Roster contains duplicate National Dex number: ${entry.num}`
      );
    }

    speciesIds.add(entry.id);
    nationalDexNumbers.add(entry.num);
  }

  return [...species].sort((left, right) =>
    left.num - right.num
  );
}

function buildSampleRoster(configuredRoster) {
  if (!Array.isArray(configuredRoster)) {
    throw new TypeError(
      'Configured sample roster must be an array'
    );
  }

  const species = configuredRoster.map(getBaseSpecies);
  return validateAndSortRoster(species, 32);
}

function buildFullRoster() {
  return validateAndSortRoster(listBaseSpecies(), 1025);
}

function selectTournamentRoster(mode, configuredSampleRoster) {
  if (mode === 'sample') {
    return buildSampleRoster(configuredSampleRoster);
  }

  if (mode === 'full') {
    return buildFullRoster();
  }

  throw new RangeError('Tournament mode must be sample or full');
}

function shuffleRoster(preparedRoster, tournamentSeed) {
  if (!Array.isArray(preparedRoster)) {
    throw new TypeError('Prepared roster must be an array');
  }

  const rosterSeed = deriveShowdownSeed(tournamentSeed, 'roster');
  const shuffledRoster = [...preparedRoster];
  const prng = new PRNG(rosterSeed);
  prng.shuffle(shuffledRoster);

  return {rosterSeed, shuffledRoster};
}

function splitRosterIntoGroups(shuffledRoster, groupSizes) {
  if (!Array.isArray(shuffledRoster)) {
    throw new TypeError('Shuffled roster must be an array');
  }

  if (!Array.isArray(groupSizes) || groupSizes.length !== 4) {
    throw new RangeError('Exactly four group sizes are required');
  }

  if (!groupSizes.every(size => Number.isInteger(size) && size > 0)) {
    throw new RangeError('Every group size must be a positive integer');
  }

  const totalSize = groupSizes.reduce((total, size) => total + size, 0);
  if (totalSize !== shuffledRoster.length) {
    throw new RangeError('Group sizes must sum to the roster length');
  }

  const groups = {};
  let offset = 0;

  for (const [index, name] of GROUP_NAMES.entries()) {
    const nextOffset = offset + groupSizes[index];
    groups[name] = shuffledRoster.slice(offset, nextOffset);
    offset = nextOffset;
  }

  return groups;
}

module.exports = {
  validateAndSortRoster,
  buildSampleRoster,
  buildFullRoster,
  selectTournamentRoster,
  shuffleRoster,
  splitRosterIntoGroups,
};
