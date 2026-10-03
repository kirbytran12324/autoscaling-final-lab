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

test('generateKnockoutSeriesGame returns the exact game-one schedule', () => {
  const series = buildInitialKnockoutRound(
    selectedGroups(SAMPLE_ADVANCERS_PER_GROUP)
  ).series[0];
  const tournamentSeed = 'tournament-001';
  const matchId = 'r16-series-01-game-01';

  assert.deepEqual(generateKnockoutSeriesGame(series, 1, tournamentSeed), {
    seriesId: 'r16-series-01',
    gameNumber: 1,
    matchId,
    pokemon1: series.entrant1.species,
    pokemon2: series.entrant2.species,
    seed: deriveShowdownSeed(tournamentSeed, matchId),
  });
});

test('generateKnockoutSeriesGame derives its seed from the game ID', () => {
  const series = buildInitialKnockoutRound(
    selectedGroups(SAMPLE_ADVANCERS_PER_GROUP)
  ).series[0];
  const tournamentSeed = 'tournament-001';
  const game = generateKnockoutSeriesGame(series, 2, tournamentSeed);

  assert.deepEqual(
    game.seed,
    deriveShowdownSeed(tournamentSeed, game.matchId)
  );
});

test('generateKnockoutSeriesGame is deterministic', () => {
  const series = buildInitialKnockoutRound(
    selectedGroups(SAMPLE_ADVANCERS_PER_GROUP)
  ).series[0];

  assert.deepEqual(
    generateKnockoutSeriesGame(series, 3, 'tournament-001'),
    generateKnockoutSeriesGame(series, 3, 'tournament-001')
  );
});

test('generateKnockoutSeriesGame alternates sides for odd and even games', () => {
  const series = buildInitialKnockoutRound(
    selectedGroups(SAMPLE_ADVANCERS_PER_GROUP)
  ).series[0];
  const games = [1, 2, 3].map(gameNumber =>
    generateKnockoutSeriesGame(series, gameNumber, 'tournament-001')
  );

  assert.deepEqual(
    games.map(game => [game.pokemon1, game.pokemon2]),
    [
      [series.entrant1.species, series.entrant2.species],
      [series.entrant2.species, series.entrant1.species],
      [series.entrant1.species, series.entrant2.species],
    ]
  );
});

test('generateKnockoutSeriesGame varies IDs and seeds by game number', () => {
  const series = buildInitialKnockoutRound(
    selectedGroups(SAMPLE_ADVANCERS_PER_GROUP)
  ).series[0];
  const first = generateKnockoutSeriesGame(
    series, 1, 'tournament-001'
  );
  const second = generateKnockoutSeriesGame(
    series, 2, 'tournament-001'
  );

  assert.notEqual(first.matchId, second.matchId);
  assert.notDeepEqual(first.seed, second.seed);
});

test('generateKnockoutSeriesGame accepts games one and seven', () => {
  const series = buildInitialKnockoutRound(
    selectedGroups(SAMPLE_ADVANCERS_PER_GROUP)
  ).series[0];

  assert.equal(
    generateKnockoutSeriesGame(series, 1, 'tournament-001').matchId,
    'r16-series-01-game-01'
  );
  assert.equal(
    generateKnockoutSeriesGame(series, 7, 'tournament-001').matchId,
    'r16-series-01-game-07'
  );
});

test('generateKnockoutSeriesGame rejects invalid game numbers', () => {
  const series = buildInitialKnockoutRound(
    selectedGroups(SAMPLE_ADVANCERS_PER_GROUP)
  ).series[0];

  for (const gameNumber of [0, 8, 1.5, '1', null, undefined]) {
    assert.throws(
      () => generateKnockoutSeriesGame(
        series, gameNumber, 'tournament-001'
      ),
      /Game number must be an integer from 1 through 7/
    );
  }
});

test('generateKnockoutSeriesGame rejects malformed inputs', () => {
  const series = buildInitialKnockoutRound(
    selectedGroups(SAMPLE_ADVANCERS_PER_GROUP)
  ).series[0];

  for (const malformedSeries of [null, [], 'series']) {
    assert.throws(
      () => generateKnockoutSeriesGame(
        malformedSeries, 1, 'tournament-001'
      ),
      /Knockout series must be an object/
    );
  }

  for (const seriesId of ['', null]) {
    assert.throws(
      () => generateKnockoutSeriesGame(
        {...series, seriesId}, 1, 'tournament-001'
      ),
      /must have a series ID/
    );
  }

  for (const entrant1 of [null, []]) {
    assert.throws(
      () => generateKnockoutSeriesGame(
        {...series, entrant1}, 1, 'tournament-001'
      ),
      /entrant1 must be an object/
    );
  }

  assert.throws(
    () => generateKnockoutSeriesGame(
      {...series, entrant2: []}, 1, 'tournament-001'
    ),
    /entrant2 must be an object/
  );
  assert.throws(
    () => generateKnockoutSeriesGame({
      ...series,
      entrant1: {...series.entrant1, species: ''},
    }, 1, 'tournament-001'),
    /entrant1 must have a species/
  );
  assert.throws(
    () => generateKnockoutSeriesGame({
      ...series,
      entrant2: {...series.entrant2, species: null},
    }, 1, 'tournament-001'),
    /entrant2 must have a species/
  );

  for (const tournamentSeed of ['', null, []]) {
    assert.throws(
      () => generateKnockoutSeriesGame(series, 1, tournamentSeed),
      /Tournament seed must be a non-empty string/
    );
  }
});

test('generateKnockoutSeriesGame does not mutate its series', () => {
  const series = buildInitialKnockoutRound(
    selectedGroups(SAMPLE_ADVANCERS_PER_GROUP)
  ).series[0];
  const entrant1 = series.entrant1;
  const entrant2 = series.entrant2;
  const snapshot = structuredClone(series);

  generateKnockoutSeriesGame(series, 2, 'tournament-001');

  assert.strictEqual(series.entrant1, entrant1);
  assert.strictEqual(series.entrant2, entrant2);
  assert.deepEqual(series, snapshot);
});
