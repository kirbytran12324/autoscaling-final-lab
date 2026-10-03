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

test('buildInitialKnockoutRound creates the exact sample pairings', () => {
  const result = buildInitialKnockoutRound(
    selectedGroups(SAMPLE_ADVANCERS_PER_GROUP)
  );

  assert.equal(result.round, 'r16');
  assert.deepEqual(
    result.series.map(series => ({
      seriesId: series.seriesId,
      position: series.position,
      pairing: `${series.entrant1.group}${series.entrant1.rank}-` +
        `${series.entrant2.group}${series.entrant2.rank}`,
    })),
    [
      {seriesId: 'r16-series-01', position: 1, pairing: 'A1-B4'},
      {seriesId: 'r16-series-02', position: 2, pairing: 'B1-A4'},
      {seriesId: 'r16-series-03', position: 3, pairing: 'A2-B3'},
      {seriesId: 'r16-series-04', position: 4, pairing: 'B2-A3'},
      {seriesId: 'r16-series-05', position: 5, pairing: 'C1-D4'},
      {seriesId: 'r16-series-06', position: 6, pairing: 'D1-C4'},
      {seriesId: 'r16-series-07', position: 7, pairing: 'C2-D3'},
      {seriesId: 'r16-series-08', position: 8, pairing: 'D2-C3'},
    ]
  );
  assert.ok(result.series.every(series =>
    [series.entrant1, series.entrant2].every(entrant =>
      Object.keys(entrant).sort().join(',') ===
        'group,rank,species,speciesId'
    )
  ));
});

test('buildInitialKnockoutRound creates 32 full-mode series', () => {
  const result = buildInitialKnockoutRound(
    selectedGroups(FULL_ADVANCERS_PER_GROUP)
  );

  assert.equal(result.round, 'r64');
  assert.equal(result.series.length, 32);
  assert.equal(result.series[0].seriesId, 'r64-series-01');
  assert.equal(result.series[31].seriesId, 'r64-series-32');
  assert.deepEqual(
    result.series.map(series => series.position),
    Array.from({length: 32}, (_, index) => index + 1)
  );
});

test('buildInitialKnockoutRound creates full-mode boundary pairings', () => {
  const {series} = buildInitialKnockoutRound(
    selectedGroups(FULL_ADVANCERS_PER_GROUP)
  );
  const pairingAt = index =>
    `${series[index].entrant1.group}${series[index].entrant1.rank}-` +
    `${series[index].entrant2.group}${series[index].entrant2.rank}`;

  assert.deepEqual(
    [0, 1, 14, 15, 16, 17, 30, 31].map(pairingAt),
    [
      'A1-B16', 'B1-A16', 'A8-B9', 'B8-A9',
      'C1-D16', 'D1-C16', 'C8-D9', 'D8-C9',
    ]
  );
});

test('buildInitialKnockoutRound uses every qualifying species once', () => {
  const selections = selectedGroups(FULL_ADVANCERS_PER_GROUP);
  const expectedSpeciesIds = selections
    .flatMap(selection => selection.advancers)
    .map(entrant => entrant.speciesId);
  const actualSpeciesIds = buildInitialKnockoutRound(selections).series
    .flatMap(series => [series.entrant1, series.entrant2])
    .map(entrant => entrant.speciesId);

  assert.equal(actualSpeciesIds.length, 64);
  assert.equal(new Set(actualSpeciesIds).size, 64);
  assert.deepEqual(
    [...actualSpeciesIds].sort(),
    [...expectedSpeciesIds].sort()
  );
});

test('buildInitialKnockoutRound never pairs the same group', () => {
  const {series} = buildInitialKnockoutRound(
    selectedGroups(FULL_ADVANCERS_PER_GROUP)
  );

  assert.ok(series.every(entry =>
    entry.entrant1.group !== entry.entrant2.group
  ));
});

test('buildInitialKnockoutRound ignores input group order', () => {
  const selections = selectedGroups(SAMPLE_ADVANCERS_PER_GROUP);
  const expected = buildInitialKnockoutRound(selections);

  assert.deepEqual(
    buildInitialKnockoutRound([...selections].reverse()),
    expected
  );
});

test('buildInitialKnockoutRound rejects invalid group sets', () => {
  const selections = selectedGroups(SAMPLE_ADVANCERS_PER_GROUP);

  assert.throws(
    () => buildInitialKnockoutRound(selections.slice(0, 3)),
    /exactly four groups/
  );

  const unknownGroup = structuredClone(selections);
  unknownGroup[3].group = 'E';
  assert.throws(
    () => buildInitialKnockoutRound(unknownGroup),
    /Unknown advancing group/
  );

  const duplicateGroup = structuredClone(selections);
  duplicateGroup[3].group = 'A';
  assert.throws(
    () => buildInitialKnockoutRound(duplicateGroup),
    /Duplicate advancing group/
  );
});

test('buildInitialKnockoutRound rejects invalid advancement counts', () => {
  const inconsistent = selectedGroups(SAMPLE_ADVANCERS_PER_GROUP);
  inconsistent[3].advancingCount = FULL_ADVANCERS_PER_GROUP;
  assert.throws(
    () => buildInitialKnockoutRound(inconsistent),
    /same advancing count/
  );

  assert.throws(
    () => buildInitialKnockoutRound(selectedGroups(8)),
    /4 for sample mode or 16 for full mode/
  );
});

test('buildInitialKnockoutRound rejects invalid entrant ranks', () => {
  const missingEntrant = selectedGroups(SAMPLE_ADVANCERS_PER_GROUP);
  missingEntrant[0].advancers.pop();
  assert.throws(
    () => buildInitialKnockoutRound(missingEntrant),
    /exactly 4 advancers/
  );

  const missingRank = selectedGroups(SAMPLE_ADVANCERS_PER_GROUP);
  delete missingRank[0].advancers[0].rank;
  assert.throws(
    () => buildInitialKnockoutRound(missingRank),
    /invalid rank/
  );

  const malformedRank = selectedGroups(SAMPLE_ADVANCERS_PER_GROUP);
  malformedRank[0].advancers[0].rank = 1.5;
  assert.throws(
    () => buildInitialKnockoutRound(malformedRank),
    /invalid rank/
  );

  const duplicateRank = selectedGroups(SAMPLE_ADVANCERS_PER_GROUP);
  duplicateRank[0].advancers[1].rank = 1;
  assert.throws(
    () => buildInitialKnockoutRound(duplicateRank),
    /invalid rank/
  );

  const outOfOrder = selectedGroups(SAMPLE_ADVANCERS_PER_GROUP);
  [outOfOrder[0].advancers[0], outOfOrder[0].advancers[1]] =
    [outOfOrder[0].advancers[1], outOfOrder[0].advancers[0]];
  assert.throws(
    () => buildInitialKnockoutRound(outOfOrder),
    /invalid rank/
  );

  const malformedEntrant = selectedGroups(SAMPLE_ADVANCERS_PER_GROUP);
  malformedEntrant[0].advancers[0].speciesId = '';
  assert.throws(
    () => buildInitialKnockoutRound(malformedEntrant),
    /invalid species fields/
  );
});

test('buildInitialKnockoutRound rejects duplicate species', () => {
  const selections = selectedGroups(SAMPLE_ADVANCERS_PER_GROUP);
  selections[1].advancers[0].speciesId =
    selections[0].advancers[0].speciesId;
  selections[1].advancers[0].species =
    selections[0].advancers[0].species;

  assert.throws(
    () => buildInitialKnockoutRound(selections),
    /Duplicate knockout species/
  );
});

test('buildInitialKnockoutRound preserves and isolates its inputs', () => {
  const selections = selectedGroups(SAMPLE_ADVANCERS_PER_GROUP);
  const snapshot = structuredClone(selections);
  const result = buildInitialKnockoutRound(selections);
  const firstInputEntrant = selections
    .find(selection => selection.group === 'A')
    .advancers[0];

  assert.deepEqual(selections, snapshot);
  assert.notStrictEqual(result.series[0].entrant1, firstInputEntrant);

  result.series[0].entrant1.species = 'Changed';
  result.series[0].entrant1.rank = 99;

  assert.deepEqual(selections, snapshot);
});
