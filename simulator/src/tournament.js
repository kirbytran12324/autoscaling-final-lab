'use strict';
const {createHash} = require('node:crypto');
const {PRNG} = require('pokemon-showdown');
const {
  getBaseSpecies,
  listBaseSpecies,
} = require('./catalog');

const SAMPLE_GROUP_SIZES = Object.freeze([8, 8, 8, 8]);
const FULL_GROUP_SIZES = Object.freeze([257, 256, 256, 256]);
const GROUP_NAMES = Object.freeze(['A', 'B', 'C', 'D']);

function deriveTournamentDigest(tournamentSeed, identifier) {
  return createHash('sha256')
    .update(`${tournamentSeed}\n${identifier}`, 'utf8')
    .digest();
}

function showdownSeedFromDigest(digest) {
  return [0, 2, 4, 6].map(offset =>
    digest.readUInt16BE(offset)
  );
}

function deriveShowdownSeed(tournamentSeed, identifier) {
  const digest = deriveTournamentDigest(tournamentSeed, identifier);
  return showdownSeedFromDigest(digest);
}

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

function generateGroupStageSchedule(groups, tournamentSeed) {
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) {
    throw new TypeError('Groups must be an object');
  }

  const schedule = [];

  for (const groupName of GROUP_NAMES) {
    const group = groups[groupName];
    if (!Array.isArray(group)) {
      throw new TypeError(`Group ${groupName} must be an array`);
    }

    let matchNumber = 1;

    for (let leftIndex = 0; leftIndex < group.length; leftIndex++) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < group.length;
        rightIndex++
      ) {
        const matchId = `group-${groupName}-${String(matchNumber)
          .padStart(6, '0')}`;
        const digest = deriveTournamentDigest(tournamentSeed, matchId);
        const seed = showdownSeedFromDigest(digest);
        const swapSides = Boolean(digest[8] & 0x80);
        const left = group[leftIndex];
        const right = group[rightIndex];

        schedule.push({
          matchId,
          group: groupName,
          pokemon1: swapSides ? right.name : left.name,
          pokemon2: swapSides ? left.name : right.name,
          seed,
        });
        matchNumber++;
      }
    }
  }

  return schedule;
}

module.exports = {
  SAMPLE_GROUP_SIZES,
  FULL_GROUP_SIZES,
  deriveShowdownSeed,
  buildSampleRoster,
  buildFullRoster,
  shuffleRoster,
  splitRosterIntoGroups,
  generateGroupStageSchedule,
};
