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

test('selectTournamentRoster delegates sample and full mode selection', () => {
  assert.equal(
    selectTournamentRoster('sample', sampleSpeciesNames()).length,
    32
  );
  assert.equal(selectTournamentRoster('full').length, 1025);
  assert.throws(
    () => selectTournamentRoster('preview', []),
    /mode must be sample or full/i
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
