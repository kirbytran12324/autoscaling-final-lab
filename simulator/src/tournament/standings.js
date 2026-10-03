'use strict';

const {GROUP_NAMES} = require('./rules');
const {deriveTournamentDigest} = require('./seeding');

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

module.exports = {
  validateGroupOptions,
  calculateGroupRecords,
  calculateGroupStandings,
  selectAdvancers,
};
