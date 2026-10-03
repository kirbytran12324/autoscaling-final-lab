'use strict';

const {validateRunMetadata} = require('../runner-state');
const {validateBattleResult} = require('../simulator-client');
const {FULL_GROUP_SIZES, SAMPLE_GROUP_SIZES, generateGroupStageSchedule, splitRosterIntoGroups} = require('../tournament');
const {requireObject, buildScheduleLookup, isKnockoutMatchId} = require('./common');
const {loadRosterSpecies} = require('./roster');

function reconstructGroupStage(
  runState,
  identity
) {
  requireObject(runState, 'Run state');
  requireObject(identity, 'Run identity');
  validateRunMetadata(runState.metadata, identity);

  if (runState.terminal) {
    throw new Error('Cannot build a group-stage plan for a terminal run');
  }

  if (runState.roster === undefined) {
    throw new Error('Group-stage planning requires immutable roster.json');
  }
  const rosterSeed = [...runState.roster.rosterSeed];
  const shuffledRoster = loadRosterSpecies(runState.roster, identity);
  const groupSizes = identity.mode === 'sample'
    ? SAMPLE_GROUP_SIZES
    : FULL_GROUP_SIZES;
  const groups = splitRosterIntoGroups(shuffledRoster, groupSizes);
  const groupSchedule = generateGroupStageSchedule(
    groups,
    identity.tournamentSeed
  );
  const scheduleByMatchId = buildScheduleLookup(groupSchedule);

  if (!Array.isArray(runState.acceptedRecords)) {
    throw new TypeError('Run state acceptedRecords must be an array');
  }

  const validatedRecordsByMatchId = new Map();
  const knockoutRecords = [];

  for (const record of runState.acceptedRecords) {
    const scheduledRequest = scheduleByMatchId.get(record.matchId);

    if (scheduledRequest === undefined) {
      if (isKnockoutMatchId(record.matchId)) {
        knockoutRecords.push(record);
        continue;
      }

      throw new Error(`Unknown persisted matchId "${record.matchId}"`);
    }

    try {
      validateBattleResult(
        scheduledRequest,
        record,
        identity.simulatorVersion
      );
    } catch (error) {
      throw new Error(
        `Persisted record "${record.matchId}" conflicts with its scheduled ` +
          `request: ${error.message}`,
        {cause: error}
      );
    }

    if (validatedRecordsByMatchId.has(record.matchId)) {
      throw new Error(
        `Run state contains duplicate canonical matchId "${record.matchId}"`
      );
    }

    validatedRecordsByMatchId.set(record.matchId, record);
  }

  const completedMatchIds = [];
  const missingGroupMatches = [];
  let schedulePosition = 0;
  let foundIncompleteMatch = false;

  for (const match of groupSchedule) {
    if (validatedRecordsByMatchId.has(match.matchId)) {
      completedMatchIds.push(match.matchId);

      if (!foundIncompleteMatch) {
        schedulePosition++;
      }
    } else {
      foundIncompleteMatch = true;
      missingGroupMatches.push(match);
    }
  }

  const plan = {
    terminal: false,
    stage: 'groups',
    identity: {...identity},
    runDirectory: runState.runDirectory,
    metadata: runState.metadata,
    checkpointHint: runState.checkpointHint,
    resumed: runState.resumed,
    rosterSeed,
    roster: shuffledRoster,
    groups,
    groupSchedule,
    scheduleByMatchId,
    validatedRecords: [...validatedRecordsByMatchId.values()],
    completedMatchIds,
    missingGroupMatches,
    acceptedResultCount: validatedRecordsByMatchId.size,
    schedulePosition,
  };

  return {knockoutRecords, plan};
}

function buildGroupStageRecoveryPlan(
  runState,
  identity
) {
  const reconstruction = reconstructGroupStage(
    runState,
    identity
  );

  if (reconstruction.knockoutRecords.length > 0) {
    throw new Error(
      `Persisted knockout matchId ` +
        `"${reconstruction.knockoutRecords[0].matchId}" requires knockout ` +
        'recovery planning'
    );
  }

  return reconstruction.plan;
}

module.exports = {
  reconstructGroupStage,
  buildGroupStageRecoveryPlan,
};
