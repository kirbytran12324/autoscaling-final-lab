'use strict';

const {buildCompletedMatchIndex, calculateRosterHash, resolveRunDirectory, validateCheckpoint, validateRunMetadata, validateRunRoster} = require('../runner-state');
const {validateBattleResult} = require('../simulator-client');
const {FULL_GROUP_SIZES, SAMPLE_GROUP_SIZES, generateGroupStageSchedule, splitRosterIntoGroups} = require('../tournament');
const {readRequiredJson, readRequiredJsonLines, readOptionalFailures} = require('./files');
const {identityFromMetadata, speciesFromRoster} = require('./common');
const {GROUP_NAMES, REQUIRED_FILES} = require('./constants');
const {validateStandings} = require('./standings');
const {validateBracket} = require('./bracket');

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

module.exports = {loadTournamentArtifacts};
