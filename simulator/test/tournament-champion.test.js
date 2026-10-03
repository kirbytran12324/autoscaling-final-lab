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

test('selectTournamentChampion returns the exact entrant1 summary', () => {
  const finalRound = sampleFinalRound();
  const [finalSeries] = finalRound.series;
  const tournamentSeed = 'tournament-001';
  const games = acceptedKnockoutGames(
    finalSeries,
    tournamentSeed,
    ['entrant1', 'entrant1']
  );
  const entrant = finalSeries.entrant1;

  assert.deepEqual(
    selectTournamentChampion(finalRound, games, tournamentSeed),
    {
      finalSeriesId: 'r2-series-01',
      winnerSlot: 'entrant1',
      champion: {
        group: entrant.group,
        rank: entrant.rank,
        speciesId: entrant.speciesId,
        species: entrant.species,
        sourceSeriesId: 'r4-series-01',
      },
      resolution: 'two-wins',
      gamesPlayed: 2,
      entrant1Wins: 2,
      entrant2Wins: 0,
      draws: 0,
      lotteryHash: null,
    }
  );
});

test('selectTournamentChampion selects entrant2 across alternating sides', () => {
  const finalRound = sampleFinalRound();
  const [finalSeries] = finalRound.series;
  const tournamentSeed = 'tournament-001';
  const games = acceptedKnockoutGames(
    finalSeries,
    tournamentSeed,
    ['entrant2', 'entrant2']
  );
  const result = selectTournamentChampion(
    finalRound,
    games,
    tournamentSeed
  );

  assert.deepEqual(
    games.map(game => game.winnerSide),
    ['p2', 'p1']
  );
  assert.equal(result.winnerSlot, 'entrant2');
  assert.deepEqual(result.champion, finalSeries.entrant2);
});

test('selectTournamentChampion preserves game-cap resolution and counts', () => {
  const finalRound = sampleFinalRound();
  const [finalSeries] = finalRound.series;
  const tournamentSeed = 'tournament-001';
  const games = acceptedKnockoutGames(
    finalSeries,
    tournamentSeed,
    ['entrant2', 'tie', 'tie', 'tie', 'tie', 'tie', 'tie']
  );
  const result = selectTournamentChampion(
    finalRound,
    games,
    tournamentSeed
  );

  assert.equal(result.winnerSlot, 'entrant2');
  assert.equal(result.resolution, 'game-cap-wins');
  assert.equal(result.gamesPlayed, 7);
  assert.equal(result.entrant1Wins, 0);
  assert.equal(result.entrant2Wins, 1);
  assert.equal(result.draws, 6);
  assert.equal(result.lotteryHash, null);
});

test('selectTournamentChampion preserves the exact hash lottery', () => {
  const finalRound = sampleFinalRound();
  const [finalSeries] = finalRound.series;
  const tournamentSeed = 'tournament-001';
  const games = acceptedKnockoutGames(
    finalSeries,
    tournamentSeed,
    ['tie', 'tie', 'tie', 'tie', 'tie', 'tie', 'tie']
  );
  const lotteryHash = createHash('sha256')
    .update(`${tournamentSeed}\n${finalSeries.seriesId}-lottery`, 'utf8')
    .digest('hex');
  const winnerSlot = parseInt(lotteryHash.slice(0, 2), 16) & 0x80
    ? 'entrant2'
    : 'entrant1';
  const result = selectTournamentChampion(
    finalRound,
    games,
    tournamentSeed
  );

  assert.equal(result.winnerSlot, winnerSlot);
  assert.equal(result.resolution, 'hash-lottery');
  assert.equal(result.gamesPlayed, 7);
  assert.equal(result.entrant1Wins, 0);
  assert.equal(result.entrant2Wins, 0);
  assert.equal(result.draws, 7);
  assert.equal(result.lotteryHash, lotteryHash);
});

test('selectTournamentChampion rejects an incomplete final', () => {
  assert.throws(
    () => selectTournamentChampion(
      sampleFinalRound(),
      [],
      'tournament-001'
    ),
    /Final series is incomplete/
  );
});

test('selectTournamentChampion delegates malformed game validation', () => {
  const finalRound = sampleFinalRound();
  const [finalSeries] = finalRound.series;
  const tournamentSeed = 'tournament-001';
  const games = acceptedKnockoutGames(
    finalSeries,
    tournamentSeed,
    ['entrant1', 'entrant1']
  );
  games[0].seed[0] ^= 1;

  assert.throws(
    () => selectTournamentChampion(finalRound, games, tournamentSeed),
    /Accepted game 1 has an inconsistent seed/
  );
});

test('selectTournamentChampion rejects invalid final round containers', () => {
  for (const finalRound of [null, [], 'r2']) {
    assert.throws(
      () => selectTournamentChampion(finalRound, [], 'tournament-001'),
      /Final round must be an object/
    );
  }

  const nonFinalRound = knockoutRound('r4');
  assert.throws(
    () => selectTournamentChampion(nonFinalRound, [], 'tournament-001'),
    /Final round must be r2/
  );
});

test('selectTournamentChampion rejects malformed final series', () => {
  const validFinalRound = sampleFinalRound();
  const mutations = [
    round => { round.series = null; },
    round => { round.series = []; },
    round => { round.series.push(structuredClone(round.series[0])); },
    round => { round.series[0] = null; },
    round => { round.series[0].seriesId = 'r2-series-02'; },
    round => { round.series[0].position = 2; },
    round => { round.series[0].entrant1 = null; },
    round => { round.series[0].entrant1.group = ''; },
    round => { round.series[0].entrant2.rank = 0; },
    round => { round.series[0].entrant2.speciesId = ''; },
  ];

  for (const mutate of mutations) {
    const finalRound = structuredClone(validFinalRound);
    mutate(finalRound);

    assert.throws(
      () => selectTournamentChampion(finalRound, [], 'tournament-001'),
      /series must be an array|exactly one series|Final series must be an object|must have ID r2-series-01|occupy position 1|must be an object|invalid identity fields|positive integer rank/
    );
  }
});

test('selectTournamentChampion rejects invalid source-series provenance', () => {
  const mutations = [
    round => { delete round.series[0].entrant1.sourceSeriesId; },
    round => { round.series[0].entrant2.sourceSeriesId = ''; },
    round => { round.series[0].entrant1.sourceSeriesId = 1; },
    round => {
      round.series[0].entrant1.sourceSeriesId = 'r4-series-02';
    },
    round => {
      round.series[0].entrant2.sourceSeriesId = 'r4-series-01';
    },
  ];

  for (const mutate of mutations) {
    const finalRound = sampleFinalRound();
    mutate(finalRound);

    assert.throws(
      () => selectTournamentChampion(finalRound, [], 'tournament-001'),
      /must have a source series ID|must come from r4-series/
    );
  }
});

test('selectTournamentChampion rejects duplicate final entrants', () => {
  const duplicateId = sampleFinalRound();
  duplicateId.series[0].entrant2.speciesId =
    duplicateId.series[0].entrant1.speciesId;
  assert.throws(
    () => selectTournamentChampion(duplicateId, [], 'tournament-001'),
    /must be distinct species/
  );

  const duplicateName = sampleFinalRound();
  duplicateName.series[0].entrant2.species =
    duplicateName.series[0].entrant1.species;
  assert.throws(
    () => selectTournamentChampion(duplicateName, [], 'tournament-001'),
    /must be distinct species/
  );
});

test('selectTournamentChampion preserves and isolates its inputs', () => {
  const finalRound = sampleFinalRound();
  const [finalSeries] = finalRound.series;
  const tournamentSeed = 'tournament-001';
  const games = acceptedKnockoutGames(
    finalSeries,
    tournamentSeed,
    ['entrant2', 'entrant2']
  );
  const finalRoundSnapshot = structuredClone(finalRound);
  const gamesSnapshot = structuredClone(games);
  const result = selectTournamentChampion(
    finalRound,
    games,
    tournamentSeed
  );

  assert.deepEqual(finalRound, finalRoundSnapshot);
  assert.deepEqual(games, gamesSnapshot);
  assert.notStrictEqual(result.champion, finalSeries.entrant1);
  assert.notStrictEqual(result.champion, finalSeries.entrant2);

  result.champion.species = 'Changed';
  result.champion.sourceSeriesId = 'Changed';
  assert.deepEqual(finalRound, finalRoundSnapshot);
  assert.deepEqual(games, gamesSnapshot);
});
