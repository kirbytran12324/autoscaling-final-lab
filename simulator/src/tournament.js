'use strict';
const {createHash} = require('node:crypto');
const {PRNG} = require('pokemon-showdown');
const {
  getBaseSpecies,
  listBaseSpecies,
} = require('./catalog');

const SAMPLE_GROUP_SIZES = Object.freeze([8, 8, 8, 8]);
const FULL_GROUP_SIZES = Object.freeze([257, 256, 256, 256]);
const SAMPLE_ADVANCERS_PER_GROUP = 4;
const FULL_ADVANCERS_PER_GROUP = 16;
const GROUP_NAMES = Object.freeze(['A', 'B', 'C', 'D']);
const NEXT_KNOCKOUT_ROUND = Object.freeze({
  r64: 'r32',
  r32: 'r16',
  r16: 'r8',
  r8: 'r4',
  r4: 'r2',
});
const KNOCKOUT_SERIES_COUNTS = Object.freeze({
  r64: 32,
  r32: 16,
  r16: 8,
  r8: 4,
  r4: 2,
});

function deriveTournamentDigest(tournamentSeed, identifier) {
  return createHash('sha256')
    .update(`${tournamentSeed}\n${identifier}`, 'utf8')
    .digest();
}

function showdownSeedFromDigest(digest) {
  return [0, 2, 4, 6].map(offset =>
    digest.readUInt16BE(offset)
  );
}

function deriveShowdownSeed(tournamentSeed, identifier) {
  const digest = deriveTournamentDigest(tournamentSeed, identifier);
  return showdownSeedFromDigest(digest);
}

function validateAndSortRoster(species, expectedCount) {
  if (species.length !== expectedCount) {
    throw new RangeError(
      `Roster must contain exactly ${expectedCount} species`
    );
  }

  const speciesIds = new Set();
  const nationalDexNumbers = new Set();

  for (const entry of species) {
    if (speciesIds.has(entry.id)) {
      throw new RangeError(
        `Roster contains duplicate species: ${entry.name}`
      );
    }

    if (nationalDexNumbers.has(entry.num)) {
      throw new RangeError(
        `Roster contains duplicate National Dex number: ${entry.num}`
      );
    }

    speciesIds.add(entry.id);
    nationalDexNumbers.add(entry.num);
  }

  return [...species].sort((left, right) =>
    left.num - right.num
  );
}

function buildSampleRoster(configuredRoster) {
  if (!Array.isArray(configuredRoster)) {
    throw new TypeError(
      'Configured sample roster must be an array'
    );
  }

  const species = configuredRoster.map(getBaseSpecies);
  return validateAndSortRoster(species, 32);
}

function buildFullRoster() {
  return validateAndSortRoster(listBaseSpecies(), 1025);
}

function shuffleRoster(preparedRoster, tournamentSeed) {
  if (!Array.isArray(preparedRoster)) {
    throw new TypeError('Prepared roster must be an array');
  }

  const rosterSeed = deriveShowdownSeed(tournamentSeed, 'roster');
  const shuffledRoster = [...preparedRoster];
  const prng = new PRNG(rosterSeed);
  prng.shuffle(shuffledRoster);

  return {rosterSeed, shuffledRoster};
}

function splitRosterIntoGroups(shuffledRoster, groupSizes) {
  if (!Array.isArray(shuffledRoster)) {
    throw new TypeError('Shuffled roster must be an array');
  }

  if (!Array.isArray(groupSizes) || groupSizes.length !== 4) {
    throw new RangeError('Exactly four group sizes are required');
  }

  if (!groupSizes.every(size => Number.isInteger(size) && size > 0)) {
    throw new RangeError('Every group size must be a positive integer');
  }

  const totalSize = groupSizes.reduce((total, size) => total + size, 0);
  if (totalSize !== shuffledRoster.length) {
    throw new RangeError('Group sizes must sum to the roster length');
  }

  const groups = {};
  let offset = 0;

  for (const [index, name] of GROUP_NAMES.entries()) {
    const nextOffset = offset + groupSizes[index];
    groups[name] = shuffledRoster.slice(offset, nextOffset);
    offset = nextOffset;
  }

  return groups;
}

function generateGroupStageSchedule(groups, tournamentSeed) {
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) {
    throw new TypeError('Groups must be an object');
  }

  const schedule = [];

  for (const groupName of GROUP_NAMES) {
    const group = groups[groupName];
    if (!Array.isArray(group)) {
      throw new TypeError(`Group ${groupName} must be an array`);
    }

    let matchNumber = 1;

    for (let leftIndex = 0; leftIndex < group.length; leftIndex++) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < group.length;
        rightIndex++
      ) {
        const matchId = `group-${groupName}-${String(matchNumber)
          .padStart(6, '0')}`;
        const digest = deriveTournamentDigest(tournamentSeed, matchId);
        const seed = showdownSeedFromDigest(digest);
        const swapSides = Boolean(digest[8] & 0x80);
        const left = group[leftIndex];
        const right = group[rightIndex];

        schedule.push({
          matchId,
          group: groupName,
          pokemon1: swapSides ? right.name : left.name,
          pokemon2: swapSides ? left.name : right.name,
          seed,
        });
        matchNumber++;
      }
    }
  }

  return schedule;
}

function validateGroupOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Group calculation options must be an object');
  }

  if (options.requireComplete !== undefined &&
      typeof options.requireComplete !== 'boolean') {
    throw new TypeError('requireComplete must be a boolean');
  }

  return options.requireComplete === undefined
    ? true
    : options.requireComplete;
}

function calculateGroupRecords(groupName, groupRoster, results, options = {}) {
  if (!GROUP_NAMES.includes(groupName)) {
    throw new RangeError('Group name must be A, B, C, or D');
  }

  if (!Array.isArray(groupRoster)) {
    throw new TypeError('Group roster must be an array');
  }

  if (!Array.isArray(results)) {
    throw new TypeError('Group results must be an array');
  }

  const requireComplete = validateGroupOptions(options);

  const participantIndexes = new Map();
  const records = groupRoster.map((pokemon, index) => {
    if (!pokemon || typeof pokemon.id !== 'string' ||
        typeof pokemon.name !== 'string') {
      throw new TypeError('Group roster must contain species objects');
    }

    if (participantIndexes.has(pokemon.name)) {
      throw new RangeError(
        `Group roster contains duplicate species: ${pokemon.name}`
      );
    }

    participantIndexes.set(pokemon.name, index);

    return {
      group: groupName,
      speciesId: pokemon.id,
      species: pokemon.name,
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      points: 0,
    };
  });
  const matchIds = new Set();
  const pairings = new Set();

  for (const result of results) {
    if (!result || typeof result !== 'object') {
      throw new TypeError('Every group result must be an object');
    }

    if (result.group !== groupName) {
      throw new RangeError(
        `Result ${result.matchId} does not belong to group ${groupName}`
      );
    }

    if (typeof result.matchId !== 'string' || result.matchId === '') {
      throw new TypeError('Every group result must have a match ID');
    }

    if (matchIds.has(result.matchId)) {
      throw new RangeError(`Duplicate match ID: ${result.matchId}`);
    }
    matchIds.add(result.matchId);

    const pokemon1Index = participantIndexes.get(result.pokemon1);
    const pokemon2Index = participantIndexes.get(result.pokemon2);

    if (pokemon1Index === undefined || pokemon2Index === undefined) {
      throw new RangeError(
        `Result ${result.matchId} contains an unknown group participant`
      );
    }

    if (pokemon1Index === pokemon2Index) {
      throw new RangeError(
        `Result ${result.matchId} must contain distinct participants`
      );
    }

    const pairing = pokemon1Index < pokemon2Index
      ? `${pokemon1Index}:${pokemon2Index}`
      : `${pokemon2Index}:${pokemon1Index}`;

    if (pairings.has(pairing)) {
      throw new RangeError(
        `Duplicate group pairing: ${result.pokemon1} and ${result.pokemon2}`
      );
    }
    pairings.add(pairing);

    const pokemon1Record = records[pokemon1Index];
    const pokemon2Record = records[pokemon2Index];
    pokemon1Record.played++;
    pokemon2Record.played++;

    if (result.outcome === 'win') {
      if (result.winnerSide !== 'p1' && result.winnerSide !== 'p2') {
        throw new RangeError(
          `Result ${result.matchId} has an invalid winner side`
        );
      }

      const expectedWinner = result.winnerSide === 'p1'
        ? result.pokemon1
        : result.pokemon2;
      if (result.winnerSpecies !== expectedWinner) {
        throw new RangeError(
          `Result ${result.matchId} has an inconsistent winner`
        );
      }

      const winnerRecord = result.winnerSide === 'p1'
        ? pokemon1Record
        : pokemon2Record;
      const loserRecord = result.winnerSide === 'p1'
        ? pokemon2Record
        : pokemon1Record;
      winnerRecord.wins++;
      winnerRecord.points += 3;
      loserRecord.losses++;
    } else if (result.outcome === 'tie') {
      if (result.winnerSide != null || result.winnerSpecies != null) {
        throw new RangeError(
          `Tie ${result.matchId} must not have a winner`
        );
      }

      pokemon1Record.draws++;
      pokemon1Record.points++;
      pokemon2Record.draws++;
      pokemon2Record.points++;
    } else {
      throw new RangeError(
        `Result ${result.matchId} has an unsupported outcome`
      );
    }
  }

  const expectedPairings = groupRoster.length * (groupRoster.length - 1) / 2;
  if (requireComplete && pairings.size !== expectedPairings) {
    throw new RangeError(
      `Group ${groupName} results are incomplete: expected ` +
      `${expectedPairings} pairings, received ${pairings.size}`
    );
  }

  return records;
}

function calculateGroupStandings(
  groupName,
  groupRoster,
  results,
  tournamentSeed,
  options = {}
) {
  const records = calculateGroupRecords(
    groupName,
    groupRoster,
    results,
    options
  );
  const expectedMatches = groupRoster.length * (groupRoster.length - 1) / 2;
  const standings = records.map(record => ({
    ...record,
    miniTablePoints: 0,
    sonnebornBerger: 0,
    tieKey: deriveTournamentDigest(
      tournamentSeed,
      `rank\n${groupName}\n${record.speciesId}`
    ).toString('hex'),
  }));
  const standingsBySpecies = new Map(
    standings.map(record => [record.species, record])
  );

  for (const result of results) {
    const pokemon1Record = standingsBySpecies.get(result.pokemon1);
    const pokemon2Record = standingsBySpecies.get(result.pokemon2);

    if (pokemon1Record.points === pokemon2Record.points) {
      if (result.outcome === 'tie') {
        pokemon1Record.miniTablePoints++;
        pokemon2Record.miniTablePoints++;
      } else {
        const winnerRecord = result.winnerSide === 'p1'
          ? pokemon1Record
          : pokemon2Record;
        winnerRecord.miniTablePoints += 3;
      }
    }

    if (result.outcome === 'tie') {
      pokemon1Record.sonnebornBerger += pokemon2Record.points;
      pokemon2Record.sonnebornBerger += pokemon1Record.points;
    } else {
      const winnerRecord = result.winnerSide === 'p1'
        ? pokemon1Record
        : pokemon2Record;
      const loserRecord = result.winnerSide === 'p1'
        ? pokemon2Record
        : pokemon1Record;
      winnerRecord.sonnebornBerger += 2 * loserRecord.points;
    }
  }

  standings.sort((left, right) => {
    const scoreComparison = right.points - left.points ||
      right.miniTablePoints - left.miniTablePoints ||
      right.wins - left.wins ||
      right.sonnebornBerger - left.sonnebornBerger;

    if (scoreComparison !== 0) {
      return scoreComparison;
    }

    if (left.tieKey < right.tieKey) return -1;
    if (left.tieKey > right.tieKey) return 1;
    return 0;
  });

  standings.forEach((record, index) => {
    record.rank = index + 1;
  });

  return {
    group: groupName,
    status: results.length === expectedMatches ? 'final' : 'provisional',
    completedMatches: results.length,
    expectedMatches,
    standings,
  };
}

function selectAdvancers(groupStanding, advancingCount) {
  if (!groupStanding || typeof groupStanding !== 'object' ||
      Array.isArray(groupStanding)) {
    throw new TypeError('Group standing must be an object');
  }

  if (!GROUP_NAMES.includes(groupStanding.group)) {
    throw new RangeError('Group standing must identify group A, B, C, or D');
  }

  if (!Array.isArray(groupStanding.standings)) {
    throw new TypeError('Group standing standings must be an array');
  }

  if (groupStanding.status !== 'final') {
    throw new RangeError(
      `Cannot select advancers from a non-final group: ${groupStanding.group}`
    );
  }

  if (!Number.isInteger(groupStanding.completedMatches) ||
      groupStanding.completedMatches < 0 ||
      !Number.isInteger(groupStanding.expectedMatches) ||
      groupStanding.expectedMatches < 0 ||
      groupStanding.completedMatches !== groupStanding.expectedMatches) {
    throw new RangeError(
      `Cannot select advancers from an incomplete group: ${groupStanding.group}`
    );
  }

  if (!Number.isInteger(advancingCount) || advancingCount <= 0) {
    throw new RangeError('Advancing count must be a positive integer');
  }

  if (advancingCount > groupStanding.standings.length) {
    throw new RangeError(
      'Advancing count cannot exceed the number of standings entries'
    );
  }

  const advancers = groupStanding.standings
    .slice(0, advancingCount)
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new TypeError('Every selected standing must be an object');
      }

      if (entry.group !== groupStanding.group) {
        throw new RangeError(
          `Selected standing at rank ${index + 1} has an inconsistent group`
        );
      }

      if (!Number.isInteger(entry.rank) || entry.rank !== index + 1) {
        throw new RangeError(
          `Selected standing at position ${index + 1} has an invalid rank`
        );
      }

      if (typeof entry.speciesId !== 'string' || entry.speciesId === '' ||
          typeof entry.species !== 'string' || entry.species === '') {
        throw new TypeError(
          `Selected standing at rank ${entry.rank} has invalid species fields`
        );
      }

      return {
        group: entry.group,
        rank: entry.rank,
        speciesId: entry.speciesId,
        species: entry.species,
      };
    });

  return {
    group: groupStanding.group,
    advancingCount,
    advancers,
  };
}

function buildInitialKnockoutRound(groupAdvancers) {
  if (!Array.isArray(groupAdvancers)) {
    throw new TypeError('Group advancers must be an array');
  }

  if (groupAdvancers.length !== GROUP_NAMES.length) {
    throw new RangeError('Group advancers must contain exactly four groups');
  }

  const selectionsByGroup = new Map();

  for (const selection of groupAdvancers) {
    if (!selection || typeof selection !== 'object' ||
        Array.isArray(selection)) {
      throw new TypeError('Every group advancer selection must be an object');
    }

    if (!GROUP_NAMES.includes(selection.group)) {
      throw new RangeError(`Unknown advancing group: ${selection.group}`);
    }

    if (selectionsByGroup.has(selection.group)) {
      throw new RangeError(`Duplicate advancing group: ${selection.group}`);
    }

    selectionsByGroup.set(selection.group, selection);
  }

  const advancementCounts = new Set(
    groupAdvancers.map(selection => selection.advancingCount)
  );
  if (advancementCounts.size !== 1) {
    throw new RangeError('All groups must have the same advancing count');
  }

  const [advancingCount] = advancementCounts;
  if (advancingCount !== SAMPLE_ADVANCERS_PER_GROUP &&
      advancingCount !== FULL_ADVANCERS_PER_GROUP) {
    throw new RangeError(
      'Advancing count must be 4 for sample mode or 16 for full mode'
    );
  }

  const copiedAdvancersByGroup = new Map();
  const speciesIds = new Set();
  const speciesNames = new Set();

  for (const groupName of GROUP_NAMES) {
    const selection = selectionsByGroup.get(groupName);

    if (!selection) {
      throw new RangeError(`Missing advancing group: ${groupName}`);
    }

    if (!Array.isArray(selection.advancers)) {
      throw new TypeError(`Group ${groupName} advancers must be an array`);
    }

    if (selection.advancers.length !== advancingCount) {
      throw new RangeError(
        `Group ${groupName} must contain exactly ${advancingCount} advancers`
      );
    }

    const copiedAdvancers = selection.advancers.map((entrant, index) => {
      const expectedRank = index + 1;

      if (!entrant || typeof entrant !== 'object' ||
          Array.isArray(entrant)) {
        throw new TypeError(
          `Group ${groupName} entrant at rank ${expectedRank} must be an object`
        );
      }

      if (entrant.group !== groupName) {
        throw new RangeError(
          `Group ${groupName} entrant at rank ${expectedRank} has an ` +
          'inconsistent group'
        );
      }

      if (!Number.isInteger(entrant.rank) ||
          entrant.rank !== expectedRank) {
        throw new RangeError(
          `Group ${groupName} entrant at position ${expectedRank} has an ` +
          'invalid rank'
        );
      }

      if (typeof entrant.speciesId !== 'string' ||
          entrant.speciesId === '' ||
          typeof entrant.species !== 'string' || entrant.species === '') {
        throw new TypeError(
          `Group ${groupName} entrant at rank ${expectedRank} has invalid ` +
          'species fields'
        );
      }

      if (speciesIds.has(entrant.speciesId) ||
          speciesNames.has(entrant.species)) {
        throw new RangeError(
          `Duplicate knockout species: ${entrant.species}`
        );
      }
      speciesIds.add(entrant.speciesId);
      speciesNames.add(entrant.species);

      return {
        group: entrant.group,
        rank: entrant.rank,
        speciesId: entrant.speciesId,
        species: entrant.species,
      };
    });

    copiedAdvancersByGroup.set(groupName, copiedAdvancers);
  }

  const round = advancingCount === SAMPLE_ADVANCERS_PER_GROUP
    ? 'r16'
    : 'r64';
  const series = [];
  const groupPairs = [['A', 'B'], ['C', 'D']];

  for (const [firstGroup, secondGroup] of groupPairs) {
    const firstAdvancers = copiedAdvancersByGroup.get(firstGroup);
    const secondAdvancers = copiedAdvancersByGroup.get(secondGroup);

    for (let highRank = 1; highRank <= advancingCount / 2; highRank++) {
      const lowRank = advancingCount + 1 - highRank;
      const pairings = [
        [firstAdvancers[highRank - 1], secondAdvancers[lowRank - 1]],
        [secondAdvancers[highRank - 1], firstAdvancers[lowRank - 1]],
      ];

      for (const [entrant1, entrant2] of pairings) {
        const position = series.length + 1;
        series.push({
          seriesId: `${round}-series-${String(position).padStart(2, '0')}`,
          position,
          entrant1,
          entrant2,
        });
      }
    }
  }

  return {round, series};
}

function validateKnockoutEntrant(entrant, entrantName, seriesId) {
  if (!entrant || typeof entrant !== 'object' || Array.isArray(entrant)) {
    throw new TypeError(
      `${entrantName} in ${seriesId} must be an object`
    );
  }

  if (typeof entrant.group !== 'string' || entrant.group.trim() === '' ||
      typeof entrant.speciesId !== 'string' ||
      entrant.speciesId.trim() === '' ||
      typeof entrant.species !== 'string' ||
      entrant.species.trim() === '') {
    throw new TypeError(
      `${entrantName} in ${seriesId} has invalid identity fields`
    );
  }

  if (!Number.isInteger(entrant.rank) || entrant.rank <= 0) {
    throw new RangeError(
      `${entrantName} in ${seriesId} must have a positive integer rank`
    );
  }
}

function buildNextKnockoutRound(previousRound, seriesEvaluations) {
  if (!previousRound || typeof previousRound !== 'object' ||
      Array.isArray(previousRound)) {
    throw new TypeError('Previous knockout round must be an object');
  }

  if (!Object.hasOwn(NEXT_KNOCKOUT_ROUND, previousRound.round)) {
    throw new RangeError(
      'Previous knockout round must be r64, r32, r16, r8, or r4'
    );
  }
  const nextRound = NEXT_KNOCKOUT_ROUND[previousRound.round];

  if (!Array.isArray(previousRound.series)) {
    throw new TypeError('Previous knockout round series must be an array');
  }

  const expectedSeriesCount = KNOCKOUT_SERIES_COUNTS[previousRound.round];
  if (previousRound.series.length !== expectedSeriesCount) {
    throw new RangeError(
      `Round ${previousRound.round} must contain exactly ` +
      `${expectedSeriesCount} series`
    );
  }

  const previousSeriesById = new Map();

  for (const [index, series] of previousRound.series.entries()) {
    const expectedPosition = index + 1;

    if (!series || typeof series !== 'object' || Array.isArray(series)) {
      throw new TypeError(
        `Previous series at position ${expectedPosition} must be an object`
      );
    }

    if (!Number.isInteger(series.position) ||
        series.position !== expectedPosition) {
      throw new RangeError(
        `Previous series at position ${expectedPosition} has an invalid ` +
        'position'
      );
    }

    const expectedSeriesId = `${previousRound.round}-series-${String(
      expectedPosition
    ).padStart(2, '0')}`;
    if (series.seriesId !== expectedSeriesId) {
      throw new RangeError(
        `Previous series at position ${expectedPosition} has an invalid ` +
        'series ID'
      );
    }

    validateKnockoutEntrant(series.entrant1, 'entrant1', series.seriesId);
    validateKnockoutEntrant(series.entrant2, 'entrant2', series.seriesId);
    previousSeriesById.set(series.seriesId, series);
  }

  if (!Array.isArray(seriesEvaluations)) {
    throw new TypeError('Series evaluations must be an array');
  }

  if (seriesEvaluations.length !== expectedSeriesCount) {
    throw new RangeError(
      `Round ${previousRound.round} must have exactly ` +
      `${expectedSeriesCount} series evaluations`
    );
  }

  const winnerEntrantsBySeriesId = new Map();
  const validResolutions = new Set([
    'two-wins',
    'game-cap-wins',
    'hash-lottery',
  ]);

  for (const evaluation of seriesEvaluations) {
    if (!evaluation || typeof evaluation !== 'object' ||
        Array.isArray(evaluation)) {
      throw new TypeError('Every series evaluation must be an object');
    }

    if (typeof evaluation.seriesId !== 'string' ||
        evaluation.seriesId.trim() === '') {
      throw new TypeError('Every series evaluation must have a series ID');
    }

    if (winnerEntrantsBySeriesId.has(evaluation.seriesId)) {
      throw new RangeError(
        `Duplicate series evaluation: ${evaluation.seriesId}`
      );
    }

    const previousSeries = previousSeriesById.get(evaluation.seriesId);
    if (!previousSeries) {
      throw new RangeError(
        `Unknown series evaluation: ${evaluation.seriesId}`
      );
    }

    if (evaluation.status !== 'complete' ||
        evaluation.nextGameNumber !== null) {
      throw new RangeError(
        `Series evaluation ${evaluation.seriesId} is not complete`
      );
    }

    if (!validResolutions.has(evaluation.resolution)) {
      throw new RangeError(
        `Series evaluation ${evaluation.seriesId} has an invalid resolution`
      );
    }

    const winner = evaluation.winner;
    if (!winner || typeof winner !== 'object' || Array.isArray(winner)) {
      throw new TypeError(
        `Series evaluation ${evaluation.seriesId} must have a winner`
      );
    }

    if (winner.slot !== 'entrant1' && winner.slot !== 'entrant2') {
      throw new RangeError(
        `Series evaluation ${evaluation.seriesId} has an invalid winner slot`
      );
    }

    validateKnockoutEntrant(
      winner,
      'Winner',
      evaluation.seriesId
    );

    const previousEntrant = previousSeries[winner.slot];
    if (winner.group !== previousEntrant.group ||
        winner.rank !== previousEntrant.rank ||
        winner.speciesId !== previousEntrant.speciesId ||
        winner.species !== previousEntrant.species) {
      throw new RangeError(
        `Series evaluation ${evaluation.seriesId} has an inconsistent winner`
      );
    }

    winnerEntrantsBySeriesId.set(evaluation.seriesId, previousEntrant);
  }

  const series = [];

  for (let index = 0; index < previousRound.series.length; index += 2) {
    const firstPreviousSeries = previousRound.series[index];
    const secondPreviousSeries = previousRound.series[index + 1];
    const firstWinner = winnerEntrantsBySeriesId.get(
      firstPreviousSeries.seriesId
    );
    const secondWinner = winnerEntrantsBySeriesId.get(
      secondPreviousSeries.seriesId
    );
    const position = index / 2 + 1;

    series.push({
      seriesId: `${nextRound}-series-${String(position).padStart(2, '0')}`,
      position,
      entrant1: {
        group: firstWinner.group,
        rank: firstWinner.rank,
        speciesId: firstWinner.speciesId,
        species: firstWinner.species,
        sourceSeriesId: firstPreviousSeries.seriesId,
      },
      entrant2: {
        group: secondWinner.group,
        rank: secondWinner.rank,
        speciesId: secondWinner.speciesId,
        species: secondWinner.species,
        sourceSeriesId: secondPreviousSeries.seriesId,
      },
    });
  }

  return {round: nextRound, series};
}

function generateKnockoutSeriesGame(series, gameNumber, tournamentSeed) {
  if (!series || typeof series !== 'object' || Array.isArray(series)) {
    throw new TypeError('Knockout series must be an object');
  }

  if (typeof series.seriesId !== 'string' || series.seriesId === '') {
    throw new TypeError('Knockout series must have a series ID');
  }

  for (const entrantName of ['entrant1', 'entrant2']) {
    const entrant = series[entrantName];

    if (!entrant || typeof entrant !== 'object' || Array.isArray(entrant)) {
      throw new TypeError(`${entrantName} must be an object`);
    }

    if (typeof entrant.species !== 'string' || entrant.species === '') {
      throw new TypeError(`${entrantName} must have a species`);
    }
  }

  if (!Number.isInteger(gameNumber) || gameNumber < 1 || gameNumber > 7) {
    throw new RangeError('Game number must be an integer from 1 through 7');
  }

  if (typeof tournamentSeed !== 'string' || tournamentSeed === '') {
    throw new TypeError('Tournament seed must be a non-empty string');
  }

  const matchId = `${series.seriesId}-game-${String(gameNumber)
    .padStart(2, '0')}`;
  const entrant1Starts = gameNumber % 2 === 1;

  return {
    seriesId: series.seriesId,
    gameNumber,
    matchId,
    pokemon1: entrant1Starts
      ? series.entrant1.species
      : series.entrant2.species,
    pokemon2: entrant1Starts
      ? series.entrant2.species
      : series.entrant1.species,
    seed: deriveShowdownSeed(tournamentSeed, matchId),
  };
}

function evaluateKnockoutSeries(series, acceptedGames, tournamentSeed) {
  if (!Array.isArray(acceptedGames)) {
    throw new TypeError('Accepted knockout games must be an array');
  }

  if (acceptedGames.length > 7) {
    throw new RangeError('A knockout series cannot contain more than 7 games');
  }

  generateKnockoutSeriesGame(series, 1, tournamentSeed);

  let entrant1Wins = 0;
  let entrant2Wins = 0;
  let draws = 0;

  for (const [index, game] of acceptedGames.entries()) {
    const expectedGameNumber = index + 1;

    if (entrant1Wins >= 2 || entrant2Wins >= 2) {
      throw new RangeError(
        `Game ${expectedGameNumber} appears after the series was complete`
      );
    }

    if (!game || typeof game !== 'object' || Array.isArray(game)) {
      throw new TypeError(
        `Accepted game ${expectedGameNumber} must be an object`
      );
    }

    const expected = generateKnockoutSeriesGame(
      series,
      expectedGameNumber,
      tournamentSeed
    );

    for (const field of [
      'seriesId',
      'gameNumber',
      'matchId',
      'pokemon1',
      'pokemon2',
    ]) {
      if (game[field] !== expected[field]) {
        throw new RangeError(
          `Accepted game ${expectedGameNumber} has an inconsistent ${field}`
        );
      }
    }

    if (!Array.isArray(game.seed) || game.seed.length !== 4 ||
        !game.seed.every((value, seedIndex) =>
          value === expected.seed[seedIndex]
        )) {
      throw new RangeError(
        `Accepted game ${expectedGameNumber} has an inconsistent seed`
      );
    }

    if (game.outcome === 'tie') {
      if (game.winnerSide !== null || game.winnerSpecies !== null) {
        throw new RangeError(
          `Tie ${game.matchId} must not have a winner`
        );
      }

      draws++;
      continue;
    }

    if (game.outcome !== 'win') {
      throw new RangeError(
        `Accepted game ${game.matchId} has an unsupported outcome`
      );
    }

    if (game.winnerSide !== 'p1' && game.winnerSide !== 'p2') {
      throw new RangeError(
        `Accepted game ${game.matchId} has an invalid winner side`
      );
    }

    const expectedWinnerSpecies = game.winnerSide === 'p1'
      ? expected.pokemon1
      : expected.pokemon2;
    if (game.winnerSpecies !== expectedWinnerSpecies) {
      throw new RangeError(
        `Accepted game ${game.matchId} has an inconsistent winner`
      );
    }

    const entrant1Won = game.winnerSide === (
      expectedGameNumber % 2 === 1 ? 'p1' : 'p2'
    );
    if (entrant1Won) {
      entrant1Wins++;
    } else {
      entrant2Wins++;
    }
  }

  const gamesPlayed = acceptedGames.length;
  let status = 'in-progress';
  let nextGameNumber = gamesPlayed + 1;
  let winnerSlot = null;
  let resolution = null;
  let lotteryHash = null;

  if (entrant1Wins >= 2 || entrant2Wins >= 2) {
    status = 'complete';
    nextGameNumber = null;
    winnerSlot = entrant1Wins >= 2 ? 'entrant1' : 'entrant2';
    resolution = 'two-wins';
  } else if (gamesPlayed === 7) {
    status = 'complete';
    nextGameNumber = null;

    if (entrant1Wins !== entrant2Wins) {
      winnerSlot = entrant1Wins > entrant2Wins ? 'entrant1' : 'entrant2';
      resolution = 'game-cap-wins';
    } else {
      const lotteryDigest = deriveTournamentDigest(
        tournamentSeed,
        `${series.seriesId}-lottery`
      );
      lotteryHash = lotteryDigest.toString('hex');
      winnerSlot = lotteryDigest[0] & 0x80 ? 'entrant2' : 'entrant1';
      resolution = 'hash-lottery';
    }
  }

  const winner = winnerSlot === null
    ? null
    : {
      slot: winnerSlot,
      group: series[winnerSlot].group,
      rank: series[winnerSlot].rank,
      speciesId: series[winnerSlot].speciesId,
      species: series[winnerSlot].species,
    };

  return {
    seriesId: series.seriesId,
    status,
    gamesPlayed,
    entrant1Wins,
    entrant2Wins,
    draws,
    nextGameNumber,
    winner,
    resolution,
    lotteryHash,
  };
}

module.exports = {
  SAMPLE_GROUP_SIZES,
  FULL_GROUP_SIZES,
  SAMPLE_ADVANCERS_PER_GROUP,
  FULL_ADVANCERS_PER_GROUP,
  deriveShowdownSeed,
  buildSampleRoster,
  buildFullRoster,
  shuffleRoster,
  splitRosterIntoGroups,
  generateGroupStageSchedule,
  calculateGroupRecords,
  calculateGroupStandings,
  selectAdvancers,
  buildInitialKnockoutRound,
  buildNextKnockoutRound,
  generateKnockoutSeriesGame,
  evaluateKnockoutSeries,
};
