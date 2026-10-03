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

test('calculateGroupStandings reports provisional completion metadata', () => {
  const roster = listBaseSpecies().slice(0, 3);
  const results = threeSpeciesGroupResults(roster).slice(0, 2);
  const result = calculateGroupStandings(
    'A', roster, results, 'tournament-001', {requireComplete: false}
  );

  assert.equal(result.group, 'A');
  assert.equal(result.status, 'provisional');
  assert.equal(result.completedMatches, 2);
  assert.equal(result.expectedMatches, 3);
});

test('calculateGroupStandings retains strict completeness by default', () => {
  const roster = listBaseSpecies().slice(0, 3);
  const results = threeSpeciesGroupResults(roster).slice(0, 2);

  assert.throws(
    () => calculateGroupStandings(
      'A', roster, results, 'tournament-001'
    ),
    /results are incomplete/
  );
});

test('calculateGroupStandings reports final completion metadata', () => {
  const roster = listBaseSpecies().slice(0, 3);
  const results = threeSpeciesGroupResults(roster);
  const result = calculateGroupStandings(
    'A', roster, results, 'tournament-001'
  );

  assert.equal(result.group, 'A');
  assert.equal(result.status, 'final');
  assert.equal(result.completedMatches, 3);
  assert.equal(result.expectedMatches, 3);
});

test('calculateGroupStandings orders by total points first', () => {
  const roster = listBaseSpecies().slice(0, 3);
  const result = calculateGroupStandings(
    'A', roster, threeSpeciesGroupResults(roster), 'tournament-001'
  );

  assert.deepEqual(
    result.standings.map(record => record.points),
    [4, 4, 0]
  );
});

test('calculateGroupStandings uses a fixed equal-points mini-table', () => {
  const roster = listBaseSpecies().slice(0, 4);
  const results = roundRobinResults(
    roster,
    ['p1', 'p2', 'p2', 'p1', 'p2', 'p1']
  );
  const standings = calculateGroupStandings(
    'A', roster, results, 'tournament-001'
  ).standings;
  const first = standings.find(record => record.speciesId === roster[0].id);
  const second = standings.find(record => record.speciesId === roster[1].id);

  assert.equal(first.points, 3);
  assert.equal(second.points, 3);
  assert.equal(first.miniTablePoints, 3);
  assert.equal(second.miniTablePoints, 0);
  assert.ok(first.rank < second.rank);
});

test('calculateGroupStandings orders by wins after equal mini-tables', () => {
  const roster = listBaseSpecies().slice(0, 5);
  const results = roundRobinResults(roster, [
    'tie', 'p1', 'p2', 'p2',
    'tie', 'tie', 'tie',
    'p2', 'p2',
    'tie',
  ]);
  const standings = calculateGroupStandings(
    'A', roster, results, 'tournament-001'
  ).standings;
  const first = standings.find(record => record.speciesId === roster[0].id);
  const second = standings.find(record => record.speciesId === roster[1].id);

  assert.equal(first.points, 4);
  assert.equal(second.points, 4);
  assert.equal(first.miniTablePoints, 1);
  assert.equal(second.miniTablePoints, 1);
  assert.equal(first.wins, 1);
  assert.equal(second.wins, 0);
  assert.ok(first.rank < second.rank);
});

test('calculateGroupStandings orders by Sonneborn-Berger next', () => {
  const roster = listBaseSpecies().slice(0, 6);
  const results = roundRobinResults(roster, [
    'tie', 'p1', 'p2', 'p2', 'p2',
    'p2', 'p1', 'p2', 'p2',
    'p2', 'p2', 'p2',
    'p2', 'p2',
    'tie',
  ]);
  const standings = calculateGroupStandings(
    'A', roster, results, 'tournament-001'
  ).standings;
  const first = standings.find(record => record.speciesId === roster[0].id);
  const second = standings.find(record => record.speciesId === roster[1].id);

  assert.equal(first.points, 4);
  assert.equal(second.points, 4);
  assert.equal(first.miniTablePoints, 1);
  assert.equal(second.miniTablePoints, 1);
  assert.equal(first.wins, 1);
  assert.equal(second.wins, 1);
  assert.equal(first.sonnebornBerger, 10);
  assert.equal(second.sonnebornBerger, 16);
  assert.ok(second.rank < first.rank);
});

test('calculateGroupStandings uses the deterministic tie key last', () => {
  const roster = listBaseSpecies().slice(0, 2);
  const results = roundRobinResults(roster, ['tie']);
  const tournamentSeed = 'tournament-001';
  const standings = calculateGroupStandings(
    'A', roster, results, tournamentSeed
  ).standings;
  const expected = roster.map(species => ({
    speciesId: species.id,
    tieKey: createHash('sha256')
      .update(`${tournamentSeed}\nrank\nA\n${species.id}`, 'utf8')
      .digest('hex'),
  })).sort((left, right) => left.tieKey.localeCompare(right.tieKey));

  assert.deepEqual(
    standings.map(record => ({
      speciesId: record.speciesId,
      tieKey: record.tieKey,
    })),
    expected
  );
  assert.deepEqual(standings.map(record => record.rank), [1, 2]);
  assert.ok(standings.every(record =>
    record.points === 1 &&
    record.miniTablePoints === 1 &&
    record.wins === 0 &&
    record.sonnebornBerger === 1
  ));
});

test('calculateGroupStandings preserves inputs and base records', () => {
  const roster = listBaseSpecies().slice(0, 3);
  const results = threeSpeciesGroupResults(roster);
  const rosterSnapshot = roster.map(species => ({
    id: species.id,
    name: species.name,
  }));
  const resultsSnapshot = structuredClone(results);
  const baseRecords = calculateGroupRecords('A', roster, results);
  const baseRecordsSnapshot = structuredClone(baseRecords);
  const standings = calculateGroupStandings(
    'A', roster, results, 'tournament-001'
  ).standings;

  assert.deepEqual(
    roster.map(species => ({id: species.id, name: species.name})),
    rosterSnapshot
  );
  assert.deepEqual(results, resultsSnapshot);
  assert.deepEqual(baseRecords, baseRecordsSnapshot);
  assert.ok(standings.every(record => {
    assert.deepEqual(Object.keys(record).sort(), [
      'draws',
      'group',
      'losses',
      'miniTablePoints',
      'played',
      'points',
      'rank',
      'sonnebornBerger',
      'species',
      'speciesId',
      'tieKey',
      'wins',
    ]);

    return Number.isInteger(record.rank) &&
      Number.isInteger(record.miniTablePoints) &&
      Number.isInteger(record.sonnebornBerger) &&
      /^[0-9a-f]{64}$/.test(record.tieKey);
  }));
});

test('selectAdvancers selects the first four entries in ranked order', () => {
  const groupStanding = calculatedStanding(8);
  const result = selectAdvancers(
    groupStanding,
    SAMPLE_ADVANCERS_PER_GROUP
  );

  assert.deepEqual(result, {
    group: 'A',
    advancingCount: 4,
    advancers: groupStanding.standings.slice(0, 4).map(entry => ({
      group: entry.group,
      rank: entry.rank,
      speciesId: entry.speciesId,
      species: entry.species,
    })),
  });
});

test('selectAdvancers supports sixteen full-tournament advancers', () => {
  const groupStanding = calculatedStanding(17);
  const result = selectAdvancers(
    groupStanding,
    FULL_ADVANCERS_PER_GROUP
  );

  assert.equal(result.advancingCount, 16);
  assert.equal(result.advancers.length, 16);
  assert.deepEqual(
    result.advancers.map(entry => entry.speciesId),
    groupStanding.standings.slice(0, 16).map(entry => entry.speciesId)
  );
  assert.deepEqual(
    result.advancers.map(entry => entry.rank),
    Array.from({length: 16}, (_, index) => index + 1)
  );
});

test('selectAdvancers rejects provisional standings', () => {
  const groupStanding = calculatedStanding(8);
  groupStanding.status = 'provisional';

  assert.throws(
    () => selectAdvancers(groupStanding, SAMPLE_ADVANCERS_PER_GROUP),
    /non-final group/
  );
});

test('selectAdvancers rejects inconsistent completion metadata', () => {
  const groupStanding = calculatedStanding(8);
  groupStanding.completedMatches--;

  assert.throws(
    () => selectAdvancers(groupStanding, SAMPLE_ADVANCERS_PER_GROUP),
    /incomplete group/
  );
});

test('selectAdvancers rejects invalid advancing counts', () => {
  const groupStanding = calculatedStanding(8);

  for (const advancingCount of [0, -1, 1.5]) {
    assert.throws(
      () => selectAdvancers(groupStanding, advancingCount),
      /positive integer/
    );
  }

  assert.throws(
    () => selectAdvancers(groupStanding, 9),
    /cannot exceed/
  );
});

test('selectAdvancers rejects malformed selected standings entries', () => {
  const mutations = [
    entry => { entry.group = 'B'; },
    entry => { entry.rank = 0; },
    entry => { entry.rank = 2; },
    entry => { entry.speciesId = ''; },
    entry => { entry.species = null; },
  ];

  for (const mutate of mutations) {
    const groupStanding = calculatedStanding(8);
    mutate(groupStanding.standings[0]);

    assert.throws(
      () => selectAdvancers(groupStanding, SAMPLE_ADVANCERS_PER_GROUP),
      /inconsistent group|invalid rank|invalid species fields/
    );
  }
});

test('selectAdvancers does not mutate the supplied standings', () => {
  const groupStanding = calculatedStanding(8);
  const snapshot = structuredClone(groupStanding);
  const standingsReference = groupStanding.standings;

  selectAdvancers(groupStanding, SAMPLE_ADVANCERS_PER_GROUP);

  assert.strictEqual(groupStanding.standings, standingsReference);
  assert.deepEqual(groupStanding, snapshot);
});

test('selectAdvancers returns advancers without shared references', () => {
  const groupStanding = calculatedStanding(8);
  const result = selectAdvancers(
    groupStanding,
    SAMPLE_ADVANCERS_PER_GROUP
  );
  const originalFirst = structuredClone(groupStanding.standings[0]);

  assert.notStrictEqual(result.advancers, groupStanding.standings);
  assert.notStrictEqual(result.advancers[0], groupStanding.standings[0]);

  result.advancers[0].species = 'Changed';
  result.advancers[0].rank = 99;

  assert.deepEqual(groupStanding.standings[0], originalFirst);
});
