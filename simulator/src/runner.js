'use strict';

const sampleRosterConfiguration = require('../config/sample_roster.json');
const {initializeOrResumeRun} = require('./runner-state');
const {validateBattleResult} = require('./simulator-client');
const {
  FULL_GROUP_SIZES,
  SAMPLE_GROUP_SIZES,
  buildFullRoster,
  buildSampleRoster,
  generateGroupStageSchedule,
  shuffleRoster,
  splitRosterIntoGroups,
} = require('./tournament');

function requireObject(value, description) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${description} must be a non-array object`);
  }
}

function isKnockoutMatchId(matchId) {
  return typeof matchId === 'string' && /^r\d+-series-/.test(matchId);
}

function buildScheduleLookup(schedule) {
  const scheduleByMatchId = new Map();

  for (const match of schedule) {
    if (scheduleByMatchId.has(match.matchId)) {
      throw new Error(`Duplicate scheduled matchId "${match.matchId}"`);
    }

    scheduleByMatchId.set(match.matchId, match);
  }

  return scheduleByMatchId;
}

function validateGroupCheckpointHint(checkpointHint) {
  if (checkpointHint === undefined || checkpointHint.stage === 'groups') {
    return;
  }

  throw new Error(
    `Unsupported ${checkpointHint.stage} recovery: this runner slice only ` +
      'plans the group stage'
  );
}

function buildGroupStageRecoveryPlan(
  runState,
  identity,
  configuredSampleRoster = sampleRosterConfiguration
) {
  requireObject(runState, 'Run state');
  requireObject(identity, 'Run identity');

  if (runState.terminal) {
    throw new Error('Cannot build a group-stage plan for a terminal run');
  }

  validateGroupCheckpointHint(runState.checkpointHint);

  const preparedRoster = identity.mode === 'sample'
    ? buildSampleRoster(configuredSampleRoster)
    : buildFullRoster();
  const {rosterSeed, shuffledRoster} = shuffleRoster(
    preparedRoster,
    identity.tournamentSeed
  );
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

  for (const record of runState.acceptedRecords) {
    const scheduledRequest = scheduleByMatchId.get(record.matchId);

    if (scheduledRequest === undefined) {
      if (isKnockoutMatchId(record.matchId)) {
        throw new Error(
          `Unsupported knockout recovery for persisted matchId ` +
            `"${record.matchId}": this runner slice only plans the group stage`
        );
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

  return {
    terminal: false,
    stage: 'groups',
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
}

async function planTournamentRun(options) {
  requireObject(options, 'Tournament runner options');

  const initializationOptions = {
    stateRoot: options.stateRoot,
    identity: options.identity,
  };

  if (options.now !== undefined) {
    initializationOptions.now = options.now;
  }

  const runState = await initializeOrResumeRun(initializationOptions);

  if (runState.terminal) {
    return {
      terminal: true,
      status: runState.metadata.status,
      runDirectory: runState.runDirectory,
      metadata: runState.metadata,
    };
  }

  return buildGroupStageRecoveryPlan(
    runState,
    options.identity,
    options.sampleRoster === undefined
      ? sampleRosterConfiguration
      : options.sampleRoster
  );
}

module.exports = {
  buildGroupStageRecoveryPlan,
  planTournamentRun,
};
