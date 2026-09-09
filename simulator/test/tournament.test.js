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
  buildSampleRoster,
  calculateGroupRecords,
  calculateGroupStandings,
  deriveShowdownSeed,
  generateGroupStageSchedule,
  generateKnockoutSeriesGame,
  selectAdvancers,
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

test('deriveShowdownSeed produces a four-number array', () => {
  const tournamentSeed = 'tournament-001';
  const identifier = 'match-001';
  const seed = deriveShowdownSeed(tournamentSeed, identifier);
  assert.ok(Array.isArray(seed));
  assert.equal(seed.length, 4);
});

test('deriveShowdownSeed produces consistent results for the same inputs', () => {
  const tournamentSeed = 'tournament-001';
  const identifier = 'match-001';
  const seed1 = deriveShowdownSeed(tournamentSeed, identifier);
  const seed2 = deriveShowdownSeed(tournamentSeed, identifier);
  assert.deepEqual(seed1, seed2);
});

test('deriveShowdownSeed produces different results for different identifiers', () => {
  const tournamentSeed = 'tournament-001';
  const identifier1 = 'match-001';
  const identifier2 = 'match-002';
  const seed1 = deriveShowdownSeed(tournamentSeed, identifier1);
  const seed2 = deriveShowdownSeed(tournamentSeed, identifier2);
  assert.notDeepEqual(seed1, seed2);
});

test('deriveShowdownSeed produces seeds for fixed vector', () => {
  assert.deepEqual(
    deriveShowdownSeed('sample-2026', 'group-A-000001'),
    [17977, 57843, 3005, 3627]
  );
});

test('buildSampleRoster resolves and sorts 32 configured species', () => {
  const configuredRoster = sampleSpeciesNames();
  const originalConfiguration = [...configuredRoster];
  const roster = buildSampleRoster(configuredRoster);

  assert.equal(roster.length, 32);
  assert.deepEqual(configuredRoster, originalConfiguration);
  assert.deepEqual(
    roster.map(species => species.num),
    [...roster]
      .map(species => species.num)
      .sort((left, right) => left - right)
  );
  assert.ok(roster.every(species =>
    species.name === species.baseSpecies
  ));
});

test('buildSampleRoster rejects the wrong number of species', () => {
  assert.throws(
    () => buildSampleRoster(sampleSpeciesNames().slice(0, 31)),
    /exactly 32 species/
  );
});

test('buildSampleRoster rejects canonical duplicates', () => {
  const configuredRoster = sampleSpeciesNames();
  configuredRoster[31] = configuredRoster[0];

  assert.throws(
    () => buildSampleRoster(configuredRoster),
    /duplicate species/
  );
});

test('buildSampleRoster reuses catalog validation', () => {
  const configuredRoster = sampleSpeciesNames();
  configuredRoster[31] = 'MissingNo';

  assert.throws(
    () => buildSampleRoster(configuredRoster),
    /tournament roster/
  );
});

test('buildFullRoster returns the complete sorted catalog', () => {
  const roster = buildFullRoster();
  const speciesIds = new Set(roster.map(species => species.id));
  const nationalDexNumbers = new Set(
    roster.map(species => species.num)
  );

  assert.equal(roster.length, 1025);
  assert.equal(speciesIds.size, 1025);
  assert.equal(nationalDexNumbers.size, 1025);
  assert.deepEqual(
    roster.map(species => species.num),
    Array.from({length: 1025}, (_, index) => index + 1)
  );
});

test('shuffleRoster is deterministic for the same roster and seed', () => {
  const roster = Array.from({length: 32}, (_, index) => index + 1);
  const first = shuffleRoster(roster, 'tournament-001');
  const second = shuffleRoster(roster, 'tournament-001');

  assert.deepEqual(first.shuffledRoster, second.shuffledRoster);
});

test('shuffleRoster changes order for a different tournament seed', () => {
  const roster = Array.from({length: 32}, (_, index) => index + 1);
  const first = shuffleRoster(roster, 'tournament-001');
  const second = shuffleRoster(roster, 'tournament-002');

  assert.notDeepEqual(first.shuffledRoster, second.shuffledRoster);
});

test('shuffleRoster does not mutate the prepared roster', () => {
  const roster = Array.from({length: 32}, (_, index) => index + 1);
  const originalRoster = [...roster];

  shuffleRoster(roster, 'tournament-001');

  assert.deepEqual(roster, originalRoster);
});

test('shuffleRoster returns the derived roster seed', () => {
  const roster = Array.from({length: 32}, (_, index) => index + 1);
  const result = shuffleRoster(roster, 'tournament-001');

  assert.deepEqual(
    result.rosterSeed,
    deriveShowdownSeed('tournament-001', 'roster')
  );
  assert.equal(result.rosterSeed.length, 4);
});

test('splitRosterIntoGroups creates four groups of eight', () => {
  const roster = Array.from({length: 32}, (_, index) => index + 1);
  const groups = splitRosterIntoGroups(roster, SAMPLE_GROUP_SIZES);
  const flattened = Object.values(groups).flat();

  assert.deepEqual(Object.keys(groups), ['A', 'B', 'C', 'D']);
  assert.deepEqual(
    Object.values(groups).map(group => group.length),
    [8, 8, 8, 8]
  );
  assert.equal(new Set(flattened).size, 32);
  assert.deepEqual(flattened, roster);
});

test('splitRosterIntoGroups uses the full tournament group sizes', () => {
  const roster = Array.from({length: 1025}, (_, index) => index + 1);
  const groups = splitRosterIntoGroups(roster, FULL_GROUP_SIZES);

  assert.deepEqual(
    Object.values(groups).map(group => group.length),
    [257, 256, 256, 256]
  );
  assert.deepEqual(Object.values(groups).flat(), roster);
});

test('splitRosterIntoGroups does not mutate the shuffled roster', () => {
  const roster = Array.from({length: 32}, (_, index) => index + 1);
  const originalRoster = [...roster];

  splitRosterIntoGroups(roster, SAMPLE_GROUP_SIZES);

  assert.deepEqual(roster, originalRoster);
});

test('splitRosterIntoGroups rejects an invalid group count', () => {
  const roster = Array.from({length: 32}, (_, index) => index + 1);

  assert.throws(
    () => splitRosterIntoGroups(roster, [8, 8, 16]),
    /Exactly four group sizes/
  );
  assert.throws(
    () => splitRosterIntoGroups(roster, [8, 8, 8, 4, 4]),
    /Exactly four group sizes/
  );
});

test('splitRosterIntoGroups rejects non-positive or non-integer sizes', () => {
  const roster = Array.from({length: 32}, (_, index) => index + 1);

  assert.throws(
    () => splitRosterIntoGroups(roster, [8, 8, 16, 0]),
    /positive integer/
  );
  assert.throws(
    () => splitRosterIntoGroups(roster, [8, 8, 15.5, 0.5]),
    /positive integer/
  );
});

test('splitRosterIntoGroups rejects sizes with an incorrect total', () => {
  const roster = Array.from({length: 32}, (_, index) => index + 1);

  assert.throws(
    () => splitRosterIntoGroups(roster, [7, 8, 8, 8]),
    /sum to the roster length/
  );
});

test('generateGroupStageSchedule creates every sample pair exactly once', () => {
  const groups = buildGroups(SAMPLE_GROUP_SIZES);
  const schedule = generateGroupStageSchedule(groups, 'tournament-001');

  assert.equal(schedule.length, 112);

  for (const groupName of ['A', 'B', 'C', 'D']) {
    const matches = schedule.filter(match => match.group === groupName);
    const pairings = new Set(matches.map(pairingKey));

    assert.equal(matches.length, 28);
    assert.equal(pairings.size, 28);
    assert.ok(matches.every(match =>
      match.pokemon1 !== match.pokemon2
    ));

    for (let leftIndex = 0; leftIndex < 8; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < 8; rightIndex++) {
        assert.ok(pairings.has([
          groups[groupName][leftIndex].name,
          groups[groupName][rightIndex].name,
        ].sort().join('|')));
      }
    }
  }
});

test('generateGroupStageSchedule creates unique stable match IDs', () => {
  const groups = buildGroups(SAMPLE_GROUP_SIZES);
  const schedule = generateGroupStageSchedule(groups, 'tournament-001');
  const repeated = generateGroupStageSchedule(groups, 'tournament-001');
  const matchIds = schedule.map(match => match.matchId);

  assert.equal(new Set(matchIds).size, 112);
  assert.equal(matchIds[0], 'group-A-000001');
  assert.equal(matchIds[27], 'group-A-000028');
  assert.equal(matchIds[28], 'group-B-000001');
  assert.equal(matchIds[111], 'group-D-000028');
  assert.deepEqual(repeated, schedule);
});

test('generateGroupStageSchedule uses the seed and byte-eight side bit', () => {
  const groups = buildGroups(SAMPLE_GROUP_SIZES);
  const tournamentSeed = 'tournament-001';
  const [match] = generateGroupStageSchedule(groups, tournamentSeed);
  const digest = createHash('sha256')
    .update(`${tournamentSeed}\n${match.matchId}`, 'utf8')
    .digest();
  const swapSides = Boolean(digest[8] & 0x80);
  const expectedParticipants = swapSides
    ? [groups.A[1].name, groups.A[0].name]
    : [groups.A[0].name, groups.A[1].name];

  assert.deepEqual(
    match.seed,
    deriveShowdownSeed(tournamentSeed, match.matchId)
  );
  assert.deepEqual(
    [match.pokemon1, match.pokemon2],
    expectedParticipants
  );
});

test('a different seed preserves group pairings but changes randomness', () => {
  const groups = buildGroups(SAMPLE_GROUP_SIZES);
  const first = generateGroupStageSchedule(groups, 'tournament-001');
  const second = generateGroupStageSchedule(groups, 'tournament-002');

  assert.deepEqual(
    first.map(match => match.matchId),
    second.map(match => match.matchId)
  );
  assert.deepEqual(
    first.map(match => `${match.group}:${pairingKey(match)}`),
    second.map(match => `${match.group}:${pairingKey(match)}`)
  );
  assert.ok(first.every((match, index) =>
    !match.seed.every((value, seedIndex) =>
      value === second[index].seed[seedIndex]
    )
  ));
  assert.ok(first.some((match, index) =>
    match.pokemon1 !== second[index].pokemon1
  ));
});

test('generateGroupStageSchedule creates all full tournament matches', () => {
  const groups = buildGroups(FULL_GROUP_SIZES);
  const schedule = generateGroupStageSchedule(groups, 'tournament-001');

  assert.equal(schedule.length, 130816);
  assert.deepEqual(
    ['A', 'B', 'C', 'D'].map(groupName =>
      schedule.filter(match => match.group === groupName).length
    ),
    [32896, 32640, 32640, 32640]
  );
});

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
