'use strict';

const {createHash} = require('node:crypto');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {listBaseSpecies} = require('../src/catalog');
const {
  FULL_ADVANCERS_PER_GROUP,
  FULL_GROUP_SIZES,
  SAMPLE_ADVANCERS_PER_GROUP,
  SAMPLE_GROUP_SIZES,
  buildFullRoster,
  buildInitialKnockoutRound,
  buildNextKnockoutRound,
  buildSampleRoster,
  calculateGroupRecords,
  calculateGroupStandings,
  deriveShowdownSeed,
  evaluateKnockoutSeries,
  generateGroupStageSchedule,
  generateKnockoutSeriesGame,
  selectAdvancers,
  selectTournamentRoster,
  selectTournamentChampion,
  shuffleRoster,
  splitRosterIntoGroups,
} = require('../src/tournament');

function sampleSpeciesNames() {
  return listBaseSpecies()
    .slice(0, 32)
    .reverse()
    .map(species => species.name);
}

function buildGroups(groupSizes) {
  const roster = listBaseSpecies().slice(0, 1025);
  const requiredSize = groupSizes.reduce((total, size) => total + size, 0);
  return splitRosterIntoGroups(roster.slice(0, requiredSize), groupSizes);
}

function pairingKey(match) {
  return [match.pokemon1, match.pokemon2].sort().join('|');
}

function threeSpeciesGroupResults(groupRoster) {
  const [first, second, third] = groupRoster.map(species => species.name);

  return [
    {
      matchId: 'group-A-000001',
      group: 'A',
      pokemon1: first,
      pokemon2: second,
      outcome: 'win',
      winnerSide: 'p1',
      winnerSpecies: first,
    },
    {
      matchId: 'group-A-000002',
      group: 'A',
      pokemon1: first,
      pokemon2: third,
      outcome: 'tie',
      winnerSide: null,
      winnerSpecies: null,
    },
    {
      matchId: 'group-A-000003',
      group: 'A',
      pokemon1: second,
      pokemon2: third,
      outcome: 'win',
      winnerSide: 'p2',
      winnerSpecies: third,
    },
  ];
}

function roundRobinResults(groupRoster, outcomes) {
  const results = [];
  let matchNumber = 1;

  for (let leftIndex = 0; leftIndex < groupRoster.length; leftIndex++) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < groupRoster.length;
      rightIndex++
    ) {
      const outcome = outcomes[matchNumber - 1];
      const pokemon1 = groupRoster[leftIndex].name;
      const pokemon2 = groupRoster[rightIndex].name;
      const isTie = outcome === 'tie';

      results.push({
        matchId: `group-A-${String(matchNumber).padStart(6, '0')}`,
        group: 'A',
        pokemon1,
        pokemon2,
        outcome: isTie ? 'tie' : 'win',
        winnerSide: isTie ? null : outcome,
        winnerSpecies: isTie
          ? null
          : outcome === 'p1' ? pokemon1 : pokemon2,
      });
      matchNumber++;
    }
  }

  assert.equal(outcomes.length, results.length);
  return results;
}

function calculatedStanding(size) {
  const roster = listBaseSpecies().slice(0, size);
  const matchCount = size * (size - 1) / 2;
  const results = roundRobinResults(
    roster,
    Array.from({length: matchCount}, () => 'p1')
  );

  return calculateGroupStandings(
    'A', roster, results, 'tournament-001'
  );
}

function selectedGroups(advancingCount) {
  const catalog = listBaseSpecies();

  return ['A', 'B', 'C', 'D'].map((group, groupIndex) => {
    const offset = groupIndex * advancingCount;
    const standings = catalog
      .slice(offset, offset + advancingCount)
      .map((species, index) => ({
        group,
        rank: index + 1,
        speciesId: species.id,
        species: species.name,
        points: advancingCount - index,
      }));

    return selectAdvancers({
      group,
      status: 'final',
      completedMatches: 1,
      expectedMatches: 1,
      standings,
    }, advancingCount);
  });
}

function sampleKnockoutSeries() {
  return buildInitialKnockoutRound(
    selectedGroups(SAMPLE_ADVANCERS_PER_GROUP)
  ).series[0];
}

function acceptedKnockoutGame(
  series,
  gameNumber,
  tournamentSeed,
  result
) {
  const game = generateKnockoutSeriesGame(
    series,
    gameNumber,
    tournamentSeed
  );

  if (result === 'tie') {
    return {
      ...game,
      outcome: 'tie',
      winnerSide: null,
      winnerSpecies: null,
    };
  }

  const winnerSpecies = series[result].species;
  const winnerSide = game.pokemon1 === winnerSpecies ? 'p1' : 'p2';

  return {
    ...game,
    outcome: 'win',
    winnerSide,
    winnerSpecies,
  };
}

function acceptedKnockoutGames(series, tournamentSeed, results) {
  return results.map((result, index) => acceptedKnockoutGame(
    series,
    index + 1,
    tournamentSeed,
    result
  ));
}

function knockoutRound(round) {
  const seriesCounts = {
    r64: 32,
    r32: 16,
    r16: 8,
    r8: 4,
    r4: 2,
    r2: 1,
  };
  const catalog = listBaseSpecies();
  const seriesCount = seriesCounts[round];

  return {
    round,
    series: Array.from({length: seriesCount}, (_, index) => {
      const position = index + 1;
      const first = catalog[index * 2];
      const second = catalog[index * 2 + 1];

      return {
        seriesId: `${round}-series-${String(position).padStart(2, '0')}`,
        position,
        entrant1: {
          group: ['A', 'B', 'C', 'D'][index % 4],
          rank: position,
          speciesId: first.id,
          species: first.name,
        },
        entrant2: {
          group: ['B', 'C', 'D', 'A'][index % 4],
          rank: position + 1,
          speciesId: second.id,
          species: second.name,
        },
      };
    }),
  };
}

function completedKnockoutEvaluations(
  round,
  winnerSlotAt = () => 'entrant1'
) {
  const tournamentSeed = 'tournament-001';

  return round.series.map((series, index) => {
    const winnerSlot = winnerSlotAt(index);
    const games = acceptedKnockoutGames(
      series,
      tournamentSeed,
      [winnerSlot, winnerSlot]
    );

    return evaluateKnockoutSeries(series, games, tournamentSeed);
  });
}

function sampleFinalRound() {
  let round = buildInitialKnockoutRound(
    selectedGroups(SAMPLE_ADVANCERS_PER_GROUP)
  );

  while (round.round !== 'r2') {
    round = buildNextKnockoutRound(
      round,
      completedKnockoutEvaluations(round)
    );
  }

  return round;
}

module.exports = {
  sampleSpeciesNames,
  buildGroups,
  pairingKey,
  threeSpeciesGroupResults,
  roundRobinResults,
  calculatedStanding,
  selectedGroups,
  sampleKnockoutSeries,
  acceptedKnockoutGame,
  acceptedKnockoutGames,
  knockoutRound,
  completedKnockoutEvaluations,
  sampleFinalRound
};
