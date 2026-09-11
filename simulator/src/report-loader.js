'use strict';

const {readFile} = require('node:fs/promises');
const {join} = require('node:path');
const {isDeepStrictEqual} = require('node:util');

const {
  buildCompletedMatchIndex,
  calculateRosterHash,
  readJsonLines,
  resolveRunDirectory,
  validateCheckpoint,
  validateRunMetadata,
  validateRunRoster,
} = require('./runner-state');
const {validateBattleResult} = require('./simulator-client');
const {
  FULL_ADVANCERS_PER_GROUP,
  FULL_GROUP_SIZES,
  SAMPLE_ADVANCERS_PER_GROUP,
  SAMPLE_GROUP_SIZES,
  buildInitialKnockoutRound,
  buildNextKnockoutRound,
  calculateGroupStandings,
  evaluateKnockoutSeries,
  generateGroupStageSchedule,
  generateKnockoutSeriesGame,
  selectAdvancers,
  selectTournamentChampion,
  splitRosterIntoGroups,
} = require('./tournament');

const GROUP_NAMES = Object.freeze(['A', 'B', 'C', 'D']);
const REQUIRED_FILES = Object.freeze([
  'run-metadata.json',
  'roster.json',
  'results.jsonl',
  'checkpoint.json',
  'standings.json',
  'bracket.json',
]);

function requireObject(value, description) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${description} must be a non-array object`);
  }
}

function requireTimestamp(value, description) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${description} must be a valid timestamp`);
  }
}

async function readRequiredJson(runDirectory, fileName) {
  let contents;

  try {
    contents = await readFile(join(runDirectory, fileName), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Required tournament artifact ${fileName} is missing`);
    }
    throw error;
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new SyntaxError(
      `Malformed tournament artifact ${fileName}: ${error.message}`,
      {cause: error}
    );
  }
}

async function readRequiredJsonLines(runDirectory, fileName) {
  try {
    await readFile(join(runDirectory, fileName), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Required tournament artifact ${fileName} is missing`);
    }
    throw error;
  }

  try {
    return await readJsonLines(join(runDirectory, fileName));
  } catch (error) {
    throw new Error(`Malformed tournament artifact ${fileName}: ${error.message}`, {
      cause: error,
    });
  }
}

function identityFromMetadata(metadata) {
  return {
    runId: metadata.runId,
    mode: metadata.mode,
    tournamentSeed: metadata.tournamentSeed,
    rulesVersion: metadata.rulesVersion,
    simulatorVersion: metadata.simulatorVersion,
    simulatorImage: metadata.simulatorImage,
    runnerConcurrency: metadata.runnerConcurrency,
  };
}

function speciesFromRoster(roster) {
  return roster.entrants.map(entrant => ({
    id: entrant.speciesId,
    name: entrant.species,
    num: entrant.nationalDexNumber,
  }));
}

function validateStandings(standings, metadata, groups, groupRecords) {
  requireObject(standings, 'standings.json');
  requireTimestamp(standings.updatedAt, 'standings.json updatedAt');
  const advancingCount = metadata.mode === 'sample'
    ? SAMPLE_ADVANCERS_PER_GROUP
    : FULL_ADVANCERS_PER_GROUP;
  const calculatedGroups = GROUP_NAMES.map(group =>
    calculateGroupStandings(
      group,
      groups[group],
      groupRecords.get(group),
      metadata.tournamentSeed
    )
  );
  const expectedCount = calculatedGroups.reduce(
    (total, group) => total + group.expectedMatches,
    0
  );

  if (standings.schemaVersion !== 1 || standings.runId !== metadata.runId ||
      standings.status !== 'final' ||
      standings.acceptedResultCount !== expectedCount ||
      standings.expectedResultCount !== expectedCount ||
      standings.advancingCount !== advancingCount ||
      !isDeepStrictEqual(standings.groups, calculatedGroups)) {
    throw new Error(
      'standings.json conflicts with the completed authoritative group results'
    );
  }

  return {advancingCount, calculatedGroups, expectedCount};
}

function rawSeries(series) {
  return {
    seriesId: series.seriesId,
    position: series.position,
    entrant1: series.entrant1,
    entrant2: series.entrant2,
  };
}

function rawRound(round) {
  return {
    round: round.round,
    series: round.series.map(rawSeries),
  };
}

function validateBracket(bracket, metadata, standings, resultsById, usedIds) {
  requireObject(bracket, 'bracket.json');
  requireTimestamp(bracket.updatedAt, 'bracket.json updatedAt');

  if (bracket.schemaVersion !== 1 || bracket.runId !== metadata.runId ||
      bracket.status !== 'completed' || !Array.isArray(bracket.rounds) ||
      bracket.rounds.length === 0) {
    throw new Error('bracket.json does not describe a completed tournament');
  }

  const selections = standings.groups.map(group =>
    selectAdvancers(group, standings.advancingCount)
  );
  let expectedRound = buildInitialKnockoutRound(selections);
  const expectedRoundNames = metadata.mode === 'sample'
    ? ['r16', 'r8', 'r4', 'r2']
    : ['r64', 'r32', 'r16', 'r8', 'r4', 'r2'];
  let finalGames;

  if (!isDeepStrictEqual(
    bracket.rounds.map(round => round.round),
    expectedRoundNames
  )) {
    throw new Error('bracket.json has an invalid knockout round progression');
  }

  for (const [roundIndex, storedRound] of bracket.rounds.entries()) {
    requireObject(storedRound, `bracket.json round ${roundIndex + 1}`);

    if (!isDeepStrictEqual(rawRound(storedRound), expectedRound)) {
      throw new Error(
        `bracket.json round ${storedRound.round} conflicts with deterministic entrants`
      );
    }

    const evaluations = [];

    for (const series of storedRound.series) {
      if (!Array.isArray(series.games) || series.games.length === 0) {
        throw new Error(`bracket.json series ${series.seriesId} has no games`);
      }

      const games = series.games.map((game, index) => {
        requireObject(game, `${series.seriesId} game ${index + 1}`);
        const gameNumber = index + 1;
        const expectedRequest = generateKnockoutSeriesGame(
          rawSeries(series),
          gameNumber,
          metadata.tournamentSeed
        );
        const result = resultsById.get(expectedRequest.matchId);

        if (result === undefined) {
          throw new Error(
            `bracket.json references missing result ${expectedRequest.matchId}`
          );
        }

        validateBattleResult(
          expectedRequest,
          result,
          metadata.simulatorVersion
        );

        if (!isDeepStrictEqual(game, {
          ...result,
          gameNumber,
        })) {
          throw new Error(
            `bracket.json game ${expectedRequest.matchId} conflicts with results.jsonl`
          );
        }

        usedIds.add(result.matchId);
        return {...game, seriesId: series.seriesId};
      });
      const evaluation = evaluateKnockoutSeries(
        rawSeries(series),
        games,
        metadata.tournamentSeed
      );

      if (evaluation.status !== 'complete' ||
          !isDeepStrictEqual(series.evaluation, evaluation)) {
        throw new Error(
          `bracket.json series ${series.seriesId} is incomplete or inconsistent`
        );
      }
      evaluations.push(evaluation);
    }

    if (roundIndex < bracket.rounds.length - 1) {
      expectedRound = buildNextKnockoutRound(expectedRound, evaluations);
    } else {
      finalGames = storedRound.series[0].games.map(game => ({
        ...game,
        seriesId: storedRound.series[0].seriesId,
      }));
    }
  }

  const expectedChampion = selectTournamentChampion(
    expectedRound,
    finalGames,
    metadata.tournamentSeed
  );
  if (!isDeepStrictEqual(bracket.champion, expectedChampion)) {
    throw new Error('bracket.json champion conflicts with final series results');
  }

  return {champion: expectedChampion, finalGameCount: finalGames.length};
}

function validateFailureRecords(records, runId) {
  for (const [index, record] of records.entries()) {
    requireObject(record, `failures.jsonl record ${index + 1}`);
    requireObject(record.request, `failures.jsonl record ${index + 1} request`);
    requireObject(record.error, `failures.jsonl record ${index + 1} error`);
    requireTimestamp(record.failedAt, `failures.jsonl record ${index + 1} failedAt`);
    if (record.schemaVersion !== 1 ||
        typeof record.matchId !== 'string' || record.matchId === '' ||
        record.runId !== runId) {
      throw new Error(
        `failures.jsonl record ${index + 1} is invalid or conflicts with run ID ${runId}`
      );
    }
  }
}

async function readOptionalFailures(runDirectory, runId) {
  let records;
  try {
    records = await readJsonLines(join(runDirectory, 'failures.jsonl'));
  } catch (error) {
    throw new Error(`Malformed tournament artifact failures.jsonl: ${error.message}`, {
      cause: error,
    });
  }
  validateFailureRecords(records, runId);
  return records;
}

async function loadTournamentArtifacts({stateRoot, runId}) {
  const runDirectory = resolveRunDirectory(stateRoot, runId);
  const [metadata, roster, rawResults, checkpoint, standings, bracket] =
    await Promise.all([
      readRequiredJson(runDirectory, 'run-metadata.json'),
      readRequiredJson(runDirectory, 'roster.json'),
      readRequiredJsonLines(runDirectory, 'results.jsonl'),
      readRequiredJson(runDirectory, 'checkpoint.json'),
      readRequiredJson(runDirectory, 'standings.json'),
      readRequiredJson(runDirectory, 'bracket.json'),
    ]);

  if (metadata.runId !== runId) {
    throw new Error(
      `Run ID conflict: requested ${runId}, artifact identifies ${String(metadata.runId)}`
    );
  }
  const identity = identityFromMetadata(metadata);
  validateRunMetadata(metadata, identity);
  validateRunRoster(roster, identity);
  validateCheckpoint(checkpoint);

  if (metadata.status !== 'completed' || checkpoint.stage !== 'complete' ||
      checkpoint.round !== 'r2') {
    throw new Error('Tournament is incomplete; report generation requires completed state');
  }

  const completed = buildCompletedMatchIndex(rawResults);
  const duplicateMatchIdCount = rawResults.length - completed.size;
  const rosterSpecies = speciesFromRoster(roster);
  const groupSizes = metadata.mode === 'sample'
    ? SAMPLE_GROUP_SIZES
    : FULL_GROUP_SIZES;
  const groups = splitRosterIntoGroups(rosterSpecies, groupSizes);
  const groupSchedule = generateGroupStageSchedule(
    groups,
    metadata.tournamentSeed
  );
  const groupRecords = new Map(GROUP_NAMES.map(group => [group, []]));
  const usedIds = new Set();

  for (const request of groupSchedule) {
    const result = completed.get(request.matchId);
    if (result === undefined) {
      throw new Error(`Completed tournament is missing result ${request.matchId}`);
    }
    validateBattleResult(request, result, metadata.simulatorVersion);
    groupRecords.get(request.group).push({...result, group: request.group});
    usedIds.add(result.matchId);
  }

  const standingValidation = validateStandings(
    standings,
    metadata,
    groups,
    groupRecords
  );
  const bracketValidation = validateBracket(
    bracket,
    metadata,
    standings,
    completed,
    usedIds
  );

  if (usedIds.size !== completed.size) {
    const unknown = [...completed.keys()].find(matchId => !usedIds.has(matchId));
    throw new Error(`results.jsonl contains unknown match ID ${unknown}`);
  }
  if (checkpoint.acceptedResultCount !== completed.size) {
    throw new Error(
      'checkpoint.json acceptedResultCount conflicts with results.jsonl'
    );
  }
  if (checkpoint.schedulePosition !== bracketValidation.finalGameCount) {
    throw new Error(
      'checkpoint.json schedulePosition conflicts with the completed final series'
    );
  }
  if (Date.parse(metadata.completedAt) < Date.parse(metadata.startedAt)) {
    throw new Error('Run metadata completion time precedes its start time');
  }

  const failures = await readOptionalFailures(runDirectory, runId);
  const results = [...completed.values()];

  return {
    runDirectory,
    sourceFiles: [...REQUIRED_FILES, ...(failures.length > 0 ? ['failures.jsonl'] : [])],
    metadata,
    roster,
    results,
    rawResultCount: rawResults.length,
    uniqueResultCount: completed.size,
    duplicateMatchIdCount,
    checkpoint,
    standings,
    bracket,
    failures,
    champion: bracketValidation.champion,
    expectedGroupResultCount: standingValidation.expectedCount,
    groupByMatchId: new Map(
      groupSchedule.map(request => [request.matchId, request.group])
    ),
    rosterHashVerified: calculateRosterHash(roster) === roster.rosterHash,
  };
}

module.exports = {
  REQUIRED_FILES,
  loadTournamentArtifacts,
};
