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

test('calculateGroupRecords calculates three-species totals', () => {
  const roster = listBaseSpecies().slice(0, 3);
  const records = calculateGroupRecords(
    'A', roster, threeSpeciesGroupResults(roster)
  );

  assert.deepEqual(records, [
    {
      group: 'A',
      speciesId: roster[0].id,
      species: roster[0].name,
      played: 2,
      wins: 1,
      draws: 1,
      losses: 0,
      points: 4,
    },
    {
      group: 'A',
      speciesId: roster[1].id,
      species: roster[1].name,
      played: 2,
      wins: 0,
      draws: 0,
      losses: 2,
      points: 0,
    },
    {
      group: 'A',
      speciesId: roster[2].id,
      species: roster[2].name,
      played: 2,
      wins: 1,
      draws: 1,
      losses: 0,
      points: 4,
    },
  ]);
});

test('calculateGroupRecords retains roster order', () => {
  const catalogSpecies = listBaseSpecies().slice(0, 3);
  const roster = [catalogSpecies[2], catalogSpecies[0], catalogSpecies[1]];
  const records = calculateGroupRecords(
    'A', roster, threeSpeciesGroupResults(roster)
  );

  assert.deepEqual(
    records.map(record => record.speciesId),
    roster.map(species => species.id)
  );
});

test('calculateGroupRecords does not mutate its inputs', () => {
  const roster = listBaseSpecies().slice(0, 3);
  const results = threeSpeciesGroupResults(roster);
  const rosterSnapshot = roster.map(species => ({
    id: species.id,
    name: species.name,
  }));
  const resultsSnapshot = structuredClone(results);

  calculateGroupRecords('A', roster, results);

  assert.deepEqual(
    roster.map(species => ({id: species.id, name: species.name})),
    rosterSnapshot
  );
  assert.deepEqual(results, resultsSnapshot);
});

test('calculateGroupRecords rejects incomplete results', () => {
  const roster = listBaseSpecies().slice(0, 3);
  const results = threeSpeciesGroupResults(roster).slice(0, 2);

  assert.throws(
    () => calculateGroupRecords('A', roster, results),
    /results are incomplete/
  );
});

test('calculateGroupRecords accepts partial results only when requested', () => {
  const roster = listBaseSpecies().slice(0, 3);
  const results = threeSpeciesGroupResults(roster).slice(0, 2);

  assert.throws(
    () => calculateGroupRecords('A', roster, results),
    /results are incomplete/
  );
  assert.deepEqual(
    calculateGroupRecords('A', roster, results, {requireComplete: false}),
    [
      {
        group: 'A',
        speciesId: roster[0].id,
        species: roster[0].name,
        played: 2,
        wins: 1,
        draws: 1,
        losses: 0,
        points: 4,
      },
      {
        group: 'A',
        speciesId: roster[1].id,
        species: roster[1].name,
        played: 1,
        wins: 0,
        draws: 0,
        losses: 1,
        points: 0,
      },
      {
        group: 'A',
        speciesId: roster[2].id,
        species: roster[2].name,
        played: 1,
        wins: 0,
        draws: 1,
        losses: 0,
        points: 1,
      },
    ]
  );
});

test('calculateGroupRecords validates completeness options', () => {
  const roster = listBaseSpecies().slice(0, 2);

  assert.throws(
    () => calculateGroupRecords('A', roster, [], null),
    /options must be an object/
  );
  assert.throws(
    () => calculateGroupRecords(
      'A', roster, [], {requireComplete: 'false'}
    ),
    /requireComplete must be a boolean/
  );
});

test('calculateGroupRecords rejects duplicate pairings and match IDs', () => {
  const roster = listBaseSpecies().slice(0, 3);
  const duplicatePairing = threeSpeciesGroupResults(roster);
  duplicatePairing[2] = {
    ...duplicatePairing[2],
    pokemon1: duplicatePairing[0].pokemon2,
    pokemon2: duplicatePairing[0].pokemon1,
  };
  const duplicateMatchId = threeSpeciesGroupResults(roster);
  duplicateMatchId[2] = {
    ...duplicateMatchId[2],
    matchId: duplicateMatchId[0].matchId,
  };

  assert.throws(
    () => calculateGroupRecords('A', roster, duplicatePairing),
    /Duplicate group pairing/
  );
  assert.throws(
    () => calculateGroupRecords('A', roster, duplicateMatchId),
    /Duplicate match ID/
  );
});

test('calculateGroupRecords rejects unknown participants and bad winners', () => {
  const roster = listBaseSpecies().slice(0, 3);
  const unknownParticipant = threeSpeciesGroupResults(roster);
  unknownParticipant[0] = {
    ...unknownParticipant[0],
    pokemon1: 'MissingNo',
    winnerSpecies: 'MissingNo',
  };
  const inconsistentWinner = threeSpeciesGroupResults(roster);
  inconsistentWinner[0] = {
    ...inconsistentWinner[0],
    winnerSpecies: inconsistentWinner[0].pokemon2,
  };

  assert.throws(
    () => calculateGroupRecords('A', roster, unknownParticipant),
    /unknown group participant/
  );
  assert.throws(
    () => calculateGroupRecords('A', roster, inconsistentWinner),
    /inconsistent winner/
  );
});
