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

test('evaluateKnockoutSeries starts an empty series at game one', () => {
  const series = sampleKnockoutSeries();

  assert.deepEqual(evaluateKnockoutSeries(series, [], 'tournament-001'), {
    seriesId: series.seriesId,
    status: 'in-progress',
    gamesPlayed: 0,
    entrant1Wins: 0,
    entrant2Wins: 0,
    draws: 0,
    nextGameNumber: 1,
    winner: null,
    resolution: null,
    lotteryHash: null,
  });
});

test('evaluateKnockoutSeries counts one win and requests game two', () => {
  const series = sampleKnockoutSeries();
  const games = acceptedKnockoutGames(
    series,
    'tournament-001',
    ['entrant1']
  );
  const result = evaluateKnockoutSeries(
    series, games, 'tournament-001'
  );

  assert.equal(result.status, 'in-progress');
  assert.equal(result.gamesPlayed, 1);
  assert.equal(result.entrant1Wins, 1);
  assert.equal(result.entrant2Wins, 0);
  assert.equal(result.draws, 0);
  assert.equal(result.nextGameNumber, 2);
});

test('evaluateKnockoutSeries counts draws without awarding wins', () => {
  const series = sampleKnockoutSeries();
  const games = acceptedKnockoutGames(
    series,
    'tournament-001',
    ['tie']
  );
  const result = evaluateKnockoutSeries(
    series, games, 'tournament-001'
  );

  assert.equal(result.entrant1Wins, 0);
  assert.equal(result.entrant2Wins, 0);
  assert.equal(result.draws, 1);
  assert.equal(result.nextGameNumber, 2);
});

test('evaluateKnockoutSeries interprets alternating sides', () => {
  const series = sampleKnockoutSeries();
  const games = acceptedKnockoutGames(
    series,
    'tournament-001',
    ['tie', 'entrant1', 'entrant2']
  );
  const result = evaluateKnockoutSeries(
    series, games, 'tournament-001'
  );

  assert.equal(games[1].winnerSide, 'p2');
  assert.equal(games[2].winnerSide, 'p2');
  assert.equal(result.entrant1Wins, 1);
  assert.equal(result.entrant2Wins, 1);
  assert.equal(result.draws, 1);
});

test('evaluateKnockoutSeries completes immediately at two wins', () => {
  const series = sampleKnockoutSeries();
  const games = acceptedKnockoutGames(
    series,
    'tournament-001',
    ['entrant1', 'entrant1']
  );

  assert.deepEqual(
    evaluateKnockoutSeries(series, games, 'tournament-001'),
    {
      seriesId: series.seriesId,
      status: 'complete',
      gamesPlayed: 2,
      entrant1Wins: 2,
      entrant2Wins: 0,
      draws: 0,
      nextGameNumber: null,
      winner: {
        slot: 'entrant1',
        group: series.entrant1.group,
        rank: series.entrant1.rank,
        speciesId: series.entrant1.speciesId,
        species: series.entrant1.species,
      },
      resolution: 'two-wins',
      lotteryHash: null,
    }
  );
});

test('evaluateKnockoutSeries gives game-seven second wins precedence', () => {
  const series = sampleKnockoutSeries();
  const games = acceptedKnockoutGames(
    series,
    'tournament-001',
    ['entrant2', 'tie', 'tie', 'tie', 'tie', 'tie', 'entrant2']
  );
  const result = evaluateKnockoutSeries(
    series, games, 'tournament-001'
  );

  assert.equal(result.status, 'complete');
  assert.equal(result.entrant2Wins, 2);
  assert.equal(result.resolution, 'two-wins');
  assert.equal(result.winner.slot, 'entrant2');
  assert.equal(result.lotteryHash, null);
});

test('evaluateKnockoutSeries resolves unequal game-cap wins', () => {
  const series = sampleKnockoutSeries();
  const games = acceptedKnockoutGames(
    series,
    'tournament-001',
    ['entrant1', 'tie', 'tie', 'tie', 'tie', 'tie', 'tie']
  );
  const result = evaluateKnockoutSeries(
    series, games, 'tournament-001'
  );

  assert.equal(result.status, 'complete');
  assert.equal(result.entrant1Wins, 1);
  assert.equal(result.entrant2Wins, 0);
  assert.equal(result.draws, 6);
  assert.equal(result.resolution, 'game-cap-wins');
  assert.equal(result.winner.slot, 'entrant1');
  assert.equal(result.lotteryHash, null);
});

test('evaluateKnockoutSeries uses a hash lottery for tied game-cap wins', () => {
  const series = sampleKnockoutSeries();
  const games = acceptedKnockoutGames(
    series,
    'tournament-001',
    ['entrant1', 'entrant2', 'tie', 'tie', 'tie', 'tie', 'tie']
  );
  const result = evaluateKnockoutSeries(
    series, games, 'tournament-001'
  );

  assert.equal(result.status, 'complete');
  assert.equal(result.entrant1Wins, 1);
  assert.equal(result.entrant2Wins, 1);
  assert.equal(result.draws, 5);
  assert.equal(result.resolution, 'hash-lottery');
  assert.match(result.lotteryHash, /^[0-9a-f]{64}$/);
  assert.ok(['entrant1', 'entrant2'].includes(result.winner.slot));
});

test('evaluateKnockoutSeries produces a deterministic lottery', () => {
  const series = sampleKnockoutSeries();
  const tournamentSeed = 'tournament-001';
  const games = acceptedKnockoutGames(
    series,
    tournamentSeed,
    ['tie', 'tie', 'tie', 'tie', 'tie', 'tie', 'tie']
  );
  const first = evaluateKnockoutSeries(series, games, tournamentSeed);
  const second = evaluateKnockoutSeries(series, games, tournamentSeed);

  assert.equal(first.lotteryHash, second.lotteryHash);
  assert.deepEqual(first.winner, second.winner);
});

test('evaluateKnockoutSeries follows the documented lottery formula', () => {
  const series = sampleKnockoutSeries();
  const tournamentSeed = 'tournament-001';
  const games = acceptedKnockoutGames(
    series,
    tournamentSeed,
    ['tie', 'tie', 'tie', 'tie', 'tie', 'tie', 'tie']
  );
  const digest = createHash('sha256')
    .update(
      `${tournamentSeed}\n${series.seriesId}-lottery`,
      'utf8'
    )
    .digest();
  const result = evaluateKnockoutSeries(
    series, games, tournamentSeed
  );

  assert.equal(result.lotteryHash, digest.toString('hex'));
  assert.match(result.lotteryHash, /^[0-9a-f]{64}$/);
  assert.equal(
    result.winner.slot,
    digest[0] & 0x80 ? 'entrant2' : 'entrant1'
  );
});

test('evaluateKnockoutSeries rejects malformed outcomes', () => {
  const series = sampleKnockoutSeries();
  const tournamentSeed = 'tournament-001';
  const tie = acceptedKnockoutGame(
    series, 1, tournamentSeed, 'tie'
  );
  const win = acceptedKnockoutGame(
    series, 1, tournamentSeed, 'entrant1'
  );
  const malformedGames = [
    {...tie, winnerSide: 'p1'},
    {...tie, winnerSpecies: series.entrant1.species},
    {...win, winnerSide: null},
    {...win, winnerSpecies: series.entrant2.species},
    {...tie, outcome: 'error'},
  ];

  for (const game of malformedGames) {
    assert.throws(
      () => evaluateKnockoutSeries(series, [game], tournamentSeed),
      /must not have a winner|invalid winner side|inconsistent winner|unsupported outcome/
    );
  }
});

test('evaluateKnockoutSeries rejects mismatched game schedules', () => {
  const series = sampleKnockoutSeries();
  const tournamentSeed = 'tournament-001';
  const game = acceptedKnockoutGame(
    series, 1, tournamentSeed, 'tie'
  );
  const mismatchedGames = [
    {...game, seriesId: 'r16-series-02'},
    {...game, gameNumber: 2},
    {...game, matchId: 'r16-series-01-game-02'},
    {...game, pokemon1: game.pokemon2},
    {...game, pokemon2: game.pokemon1},
    {...game, seed: [game.seed[0] ^ 1, ...game.seed.slice(1)]},
  ];

  for (const mismatchedGame of mismatchedGames) {
    assert.throws(
      () => evaluateKnockoutSeries(
        series, [mismatchedGame], tournamentSeed
      ),
      /inconsistent/
    );
  }
});

test('evaluateKnockoutSeries rejects invalid game sequences', () => {
  const series = sampleKnockoutSeries();
  const tournamentSeed = 'tournament-001';
  const first = acceptedKnockoutGame(
    series, 1, tournamentSeed, 'tie'
  );
  const second = acceptedKnockoutGame(
    series, 2, tournamentSeed, 'tie'
  );

  for (const games of [[second], [second, first], [first, first]]) {
    assert.throws(
      () => evaluateKnockoutSeries(series, games, tournamentSeed),
      /inconsistent/
    );
  }

  assert.throws(
    () => evaluateKnockoutSeries(
      series,
      [...acceptedKnockoutGames(
        series,
        tournamentSeed,
        ['tie', 'tie', 'tie', 'tie', 'tie', 'tie', 'tie']
      ), first],
      tournamentSeed
    ),
    /more than 7 games/
  );
});

test('evaluateKnockoutSeries rejects games after a two-win result', () => {
  const series = sampleKnockoutSeries();
  const tournamentSeed = 'tournament-001';
  const games = acceptedKnockoutGames(
    series,
    tournamentSeed,
    ['entrant1', 'entrant1', 'tie']
  );

  assert.throws(
    () => evaluateKnockoutSeries(series, games, tournamentSeed),
    /after the series was complete/
  );
});

test('evaluateKnockoutSeries rejects malformed top-level inputs', () => {
  const series = sampleKnockoutSeries();

  assert.throws(
    () => evaluateKnockoutSeries(series, null, 'tournament-001'),
    /Accepted knockout games must be an array/
  );
  assert.throws(
    () => evaluateKnockoutSeries(null, [], 'tournament-001'),
    /Knockout series must be an object/
  );
  assert.throws(
    () => evaluateKnockoutSeries(series, [], ''),
    /Tournament seed must be a non-empty string/
  );
  assert.throws(
    () => evaluateKnockoutSeries(series, [null], 'tournament-001'),
    /Accepted game 1 must be an object/
  );
});

test('evaluateKnockoutSeries preserves inputs and copies its winner', () => {
  const series = sampleKnockoutSeries();
  const games = acceptedKnockoutGames(
    series,
    'tournament-001',
    ['entrant1', 'entrant1']
  );
  const seriesSnapshot = structuredClone(series);
  const gamesSnapshot = structuredClone(games);
  const result = evaluateKnockoutSeries(
    series, games, 'tournament-001'
  );

  assert.deepEqual(series, seriesSnapshot);
  assert.deepEqual(games, gamesSnapshot);
  assert.notStrictEqual(result.winner, series.entrant1);

  result.winner.species = 'Changed';
  assert.deepEqual(series, seriesSnapshot);
});
