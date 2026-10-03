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
const {
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
} = require('../test-support/tournament');

test('buildNextKnockoutRound creates the exact sample r8 bracket', () => {
  const previousRound = buildInitialKnockoutRound(
    selectedGroups(SAMPLE_ADVANCERS_PER_GROUP)
  );
  const winnerSlots = [
    'entrant1', 'entrant2', 'entrant2', 'entrant1',
    'entrant1', 'entrant2', 'entrant2', 'entrant1',
  ];
  const evaluations = completedKnockoutEvaluations(
    previousRound,
    index => winnerSlots[index]
  );
  const result = buildNextKnockoutRound(previousRound, evaluations);
  const expectedEntrant = (seriesIndex, slot) => {
    const entrant = previousRound.series[seriesIndex][slot];

    return {
      group: entrant.group,
      rank: entrant.rank,
      speciesId: entrant.speciesId,
      species: entrant.species,
      sourceSeriesId: previousRound.series[seriesIndex].seriesId,
    };
  };

  assert.deepEqual(result, {
    round: 'r8',
    series: [
      {
        seriesId: 'r8-series-01',
        position: 1,
        entrant1: expectedEntrant(0, 'entrant1'),
        entrant2: expectedEntrant(1, 'entrant2'),
      },
      {
        seriesId: 'r8-series-02',
        position: 2,
        entrant1: expectedEntrant(2, 'entrant2'),
        entrant2: expectedEntrant(3, 'entrant1'),
      },
      {
        seriesId: 'r8-series-03',
        position: 3,
        entrant1: expectedEntrant(4, 'entrant1'),
        entrant2: expectedEntrant(5, 'entrant2'),
      },
      {
        seriesId: 'r8-series-04',
        position: 4,
        entrant1: expectedEntrant(6, 'entrant2'),
        entrant2: expectedEntrant(7, 'entrant1'),
      },
    ],
  });
  assert.ok(result.series.every(series =>
    !Object.hasOwn(series.entrant1, 'slot') &&
    !Object.hasOwn(series.entrant2, 'slot')
  ));
});

test('buildNextKnockoutRound creates all identified r32 series', () => {
  const previousRound = knockoutRound('r64');
  const result = buildNextKnockoutRound(
    previousRound,
    completedKnockoutEvaluations(previousRound)
  );

  assert.equal(result.round, 'r32');
  assert.equal(result.series.length, 16);
  assert.deepEqual(
    result.series.map(series => series.seriesId),
    Array.from({length: 16}, (_, index) =>
      `r32-series-${String(index + 1).padStart(2, '0')}`
    )
  );
  assert.deepEqual(
    result.series.map(series => series.position),
    Array.from({length: 16}, (_, index) => index + 1)
  );
});

test('buildNextKnockoutRound supports every non-final transition', () => {
  const transitions = [
    ['r64', 'r32', 16],
    ['r32', 'r16', 8],
    ['r16', 'r8', 4],
    ['r8', 'r4', 2],
    ['r4', 'r2', 1],
  ];

  for (const [previousLabel, nextLabel, seriesCount] of transitions) {
    const previousRound = knockoutRound(previousLabel);
    const result = buildNextKnockoutRound(
      previousRound,
      completedKnockoutEvaluations(previousRound)
    );

    assert.equal(result.round, nextLabel);
    assert.equal(result.series.length, seriesCount);
  }
});

test('buildNextKnockoutRound ignores evaluation completion order', () => {
  const previousRound = knockoutRound('r16');
  const evaluations = completedKnockoutEvaluations(
    previousRound,
    index => index % 2 === 0 ? 'entrant2' : 'entrant1'
  );
  const expected = buildNextKnockoutRound(previousRound, evaluations);

  assert.deepEqual(
    buildNextKnockoutRound(previousRound, [...evaluations].reverse()),
    expected
  );
});

test('buildNextKnockoutRound rejects invalid round containers', () => {
  for (const previousRound of [null, [], 'r16']) {
    assert.throws(
      () => buildNextKnockoutRound(previousRound, []),
      /Previous knockout round must be an object/
    );
  }

  assert.throws(
    () => buildNextKnockoutRound({round: 'r2', series: []}, []),
    /must be r64, r32, r16, r8, or r4/
  );
  assert.throws(
    () => buildNextKnockoutRound({round: 'r16', series: null}, []),
    /series must be an array/
  );
});

test('buildNextKnockoutRound rejects invalid previous positions', () => {
  const mutations = [
    round => { delete round.series[0].position; },
    round => { round.series[1].position = 1; },
    round => {
      [round.series[0], round.series[1]] =
        [round.series[1], round.series[0]];
    },
    round => { round.series[0].position = 1.5; },
  ];

  for (const mutate of mutations) {
    const previousRound = knockoutRound('r16');
    mutate(previousRound);

    assert.throws(
      () => buildNextKnockoutRound(previousRound, []),
      /invalid position/
    );
  }

  const missingSeries = knockoutRound('r16');
  missingSeries.series.pop();
  assert.throws(
    () => buildNextKnockoutRound(missingSeries, []),
    /exactly 8 series/
  );
});

test('buildNextKnockoutRound rejects invalid previous series IDs', () => {
  const mutations = [
    round => { delete round.series[0].seriesId; },
    round => { round.series[1].seriesId = round.series[0].seriesId; },
    round => {
      [round.series[0].seriesId, round.series[1].seriesId] =
        [round.series[1].seriesId, round.series[0].seriesId];
    },
    round => { round.series[0].seriesId = 'r16-series-1'; },
  ];

  for (const mutate of mutations) {
    const previousRound = knockoutRound('r16');
    mutate(previousRound);

    assert.throws(
      () => buildNextKnockoutRound(previousRound, []),
      /invalid series ID/
    );
  }
});

test('buildNextKnockoutRound rejects malformed previous entrants', () => {
  const mutations = [
    round => { round.series[0].entrant1 = null; },
    round => { round.series[0].entrant1.group = ''; },
    round => { round.series[0].entrant1.speciesId = ' '; },
    round => { round.series[0].entrant2.species = null; },
    round => { round.series[0].entrant2.rank = 0; },
    round => { round.series[0].entrant2.rank = 1.5; },
  ];

  for (const mutate of mutations) {
    const previousRound = knockoutRound('r16');
    mutate(previousRound);

    assert.throws(
      () => buildNextKnockoutRound(previousRound, []),
      /must be an object|invalid identity fields|positive integer rank/
    );
  }
});

test('buildNextKnockoutRound rejects invalid evaluation collections', () => {
  const previousRound = knockoutRound('r16');
  const evaluations = completedKnockoutEvaluations(previousRound);

  assert.throws(
    () => buildNextKnockoutRound(previousRound, null),
    /Series evaluations must be an array/
  );
  assert.throws(
    () => buildNextKnockoutRound(previousRound, evaluations.slice(1)),
    /exactly 8 series evaluations/
  );

  const duplicate = structuredClone(evaluations);
  duplicate[7].seriesId = duplicate[0].seriesId;
  assert.throws(
    () => buildNextKnockoutRound(previousRound, duplicate),
    /Duplicate series evaluation/
  );

  const unknown = structuredClone(evaluations);
  unknown[7].seriesId = 'r16-series-99';
  assert.throws(
    () => buildNextKnockoutRound(previousRound, unknown),
    /Unknown series evaluation/
  );

  const missingId = structuredClone(evaluations);
  delete missingId[0].seriesId;
  assert.throws(
    () => buildNextKnockoutRound(previousRound, missingId),
    /must have a series ID/
  );
});

test('buildNextKnockoutRound rejects incomplete evaluations', () => {
  const previousRound = knockoutRound('r16');
  const evaluations = completedKnockoutEvaluations(previousRound);
  const mutations = [
    result => { result.status = 'in-progress'; },
    result => { result.nextGameNumber = 3; },
  ];

  for (const mutate of mutations) {
    const malformed = structuredClone(evaluations);
    mutate(malformed[0]);

    assert.throws(
      () => buildNextKnockoutRound(previousRound, malformed),
      /is not complete/
    );
  }
});

test('buildNextKnockoutRound rejects malformed completed evaluations', () => {
  const previousRound = knockoutRound('r16');
  const evaluations = completedKnockoutEvaluations(previousRound);
  const mutations = [
    result => { result.resolution = 'coin-flip'; },
    result => { result.winner = null; },
    result => { result.winner.slot = 'p1'; },
    result => { result.winner.group = ''; },
    result => { result.winner.rank = -1; },
  ];

  for (const mutate of mutations) {
    const malformed = structuredClone(evaluations);
    mutate(malformed[0]);

    assert.throws(
      () => buildNextKnockoutRound(previousRound, malformed),
      /invalid resolution|must have a winner|invalid winner slot|invalid identity fields|positive integer rank/
    );
  }

  const malformedObject = structuredClone(evaluations);
  malformedObject[0] = null;
  assert.throws(
    () => buildNextKnockoutRound(previousRound, malformedObject),
    /Every series evaluation must be an object/
  );
});

test('buildNextKnockoutRound rejects a winner that disagrees with its slot', () => {
  const previousRound = knockoutRound('r16');
  const evaluations = completedKnockoutEvaluations(previousRound);
  evaluations[0].winner.species = previousRound.series[0].entrant2.species;

  assert.throws(
    () => buildNextKnockoutRound(previousRound, evaluations),
    /inconsistent winner/
  );
});

test('buildNextKnockoutRound preserves and isolates all inputs', () => {
  const previousRound = knockoutRound('r16');
  const evaluations = completedKnockoutEvaluations(
    previousRound,
    index => index % 2 === 0 ? 'entrant1' : 'entrant2'
  );
  const previousSnapshot = structuredClone(previousRound);
  const evaluationsSnapshot = structuredClone(evaluations);
  const result = buildNextKnockoutRound(previousRound, evaluations);
  const firstEvaluationWinner = evaluations[0].winner;
  const secondEvaluationWinner = evaluations[1].winner;

  assert.deepEqual(previousRound, previousSnapshot);
  assert.deepEqual(evaluations, evaluationsSnapshot);
  assert.notStrictEqual(
    result.series[0].entrant1,
    previousRound.series[0].entrant1
  );
  assert.notStrictEqual(result.series[0].entrant1, firstEvaluationWinner);
  assert.notStrictEqual(
    result.series[0].entrant2,
    previousRound.series[1].entrant2
  );
  assert.notStrictEqual(result.series[0].entrant2, secondEvaluationWinner);

  result.series[0].entrant1.species = 'Changed';
  result.series[0].entrant2.rank = 99;
  assert.deepEqual(previousRound, previousSnapshot);
  assert.deepEqual(evaluations, evaluationsSnapshot);
});
