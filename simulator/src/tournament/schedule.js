'use strict';

const {GROUP_NAMES} = require('./rules');
const {deriveTournamentDigest, showdownSeedFromDigest} = require('./seeding');

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
  generateGroupStageSchedule,
};
