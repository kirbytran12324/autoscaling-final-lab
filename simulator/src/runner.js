'use strict';

const {join} = require('node:path');
const {isDeepStrictEqual} = require('node:util');

const sampleRosterConfiguration = require('../config/sample_roster.json');
const {
  appendJsonLine,
  atomicWriteJson,
  initializeOrResumeRun,
  validateCheckpoint,
  validateRunMetadata,
} = require('./runner-state');
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
  validateRunMetadata(runState.metadata, identity);

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

function validateExecutionPlan(plan) {
  requireObject(plan, 'Group-stage execution plan');

  if (plan.terminal !== false || plan.stage !== 'groups') {
    throw new Error(
      'Group-stage execution requires a validated non-terminal group plan'
    );
  }

  requireObject(plan.metadata, 'Execution plan metadata');
  requireObject(plan.identity, 'Execution plan identity');
  validateRunMetadata(plan.metadata, plan.identity);
  const identity = identityFromMetadata(plan.metadata);

  if (plan.metadata.status !== 'running') {
    throw new Error('Group-stage execution requires running metadata');
  }

  if (typeof plan.runDirectory !== 'string' ||
      plan.runDirectory.trim() === '') {
    throw new TypeError('Execution plan runDirectory must be a non-empty string');
  }

  if (!Array.isArray(plan.groupSchedule) ||
      !Array.isArray(plan.missingGroupMatches) ||
      !Array.isArray(plan.completedMatchIds)) {
    throw new TypeError(
      'Execution plan schedule, missing matches, and completed IDs must be arrays'
    );
  }

  if (!Number.isInteger(plan.acceptedResultCount) ||
      plan.acceptedResultCount < 0 ||
      !Number.isInteger(plan.schedulePosition) ||
      plan.schedulePosition < 0 ||
      plan.schedulePosition > plan.groupSchedule.length) {
    throw new TypeError('Execution plan progress fields are invalid');
  }

  const scheduleByMatchId = new Map();

  for (const match of plan.groupSchedule) {
    requireObject(match, 'Scheduled group match');

    if (scheduleByMatchId.has(match.matchId)) {
      throw new Error(`Duplicate scheduled matchId "${match.matchId}"`);
    }

    scheduleByMatchId.set(match.matchId, match);
  }

  const completedIds = new Set();

  for (const matchId of plan.completedMatchIds) {
    if (!scheduleByMatchId.has(matchId)) {
      throw new Error(`Completed matchId "${matchId}" is not scheduled`);
    }

    if (completedIds.has(matchId)) {
      throw new Error(`Duplicate completed matchId "${matchId}"`);
    }

    completedIds.add(matchId);
  }

  if (plan.acceptedResultCount !== completedIds.size) {
    throw new Error(
      'Execution plan acceptedResultCount does not match completed match IDs'
    );
  }

  let expectedPosition = 0;

  while (expectedPosition < plan.groupSchedule.length &&
      completedIds.has(plan.groupSchedule[expectedPosition].matchId)) {
    expectedPosition++;
  }

  if (plan.schedulePosition !== expectedPosition) {
    throw new Error(
      'Execution plan schedulePosition is not the completed contiguous prefix'
    );
  }

  const expectedMissingMatches = plan.groupSchedule.filter(match =>
    !completedIds.has(match.matchId)
  );

  if (plan.missingGroupMatches.length !== expectedMissingMatches.length) {
    throw new Error('Execution plan missing group matches are inconsistent');
  }

  for (const [index, match] of plan.missingGroupMatches.entries()) {
    if (!isDeepStrictEqual(match, expectedMissingMatches[index])) {
      throw new Error(
        'Execution plan missing group matches are inconsistent or out of order'
      );
    }
  }

  return {completedIds, identity};
}

function resolveRunBattle(options) {
  if (typeof options.runBattle === 'function') {
    return options.runBattle;
  }

  const client = options.simulatorClient === undefined
    ? options.client
    : options.simulatorClient;

  if (client !== null && typeof client === 'object' &&
      typeof client.runBattle === 'function') {
    return client.runBattle.bind(client);
  }

  throw new TypeError(
    'Group-stage execution requires runBattle or a simulator client'
  );
}

class AcceptanceFailure extends Error {
  constructor(message, cause) {
    super(message, {cause});
    this.name = 'AcceptanceFailure';
  }
}

class StorageFailure extends Error {
  constructor(operation, cause) {
    super(`Group-stage ${operation} failed: ${cause.message}`, {cause});
    this.name = 'StorageFailure';
  }
}

async function executeGroupStagePlan(plan, options = {}) {
  const {completedIds, identity} = validateExecutionPlan(plan);

  if (plan.missingGroupMatches.length === 0) {
    return {
      stage: 'groups',
      requestedMatchCount: 0,
      acceptedMatchCount: 0,
      acceptedResultCount: plan.acceptedResultCount,
      schedulePosition: plan.schedulePosition,
    };
  }

  requireObject(options, 'Group-stage execution options');

  const runBattle = resolveRunBattle(options);
  const appendResult = options.appendJsonLine === undefined
    ? appendJsonLine
    : options.appendJsonLine;
  const writeJson = options.atomicWriteJson === undefined
    ? atomicWriteJson
    : options.atomicWriteJson;
  const now = options.now === undefined
    ? () => new Date().toISOString()
    : options.now;

  if (typeof appendResult !== 'function' ||
      typeof writeJson !== 'function' ||
      typeof now !== 'function') {
    throw new TypeError(
      'Execution persistence dependencies and now must be functions'
    );
  }

  const resultsPath = join(plan.runDirectory, 'results.jsonl');
  const checkpointPath = join(plan.runDirectory, 'checkpoint.json');
  const metadataPath = join(plan.runDirectory, 'run-metadata.json');
  const acceptedThisExecution = new Set();
  let acceptedResultCount = plan.acceptedResultCount;
  let schedulePosition = plan.schedulePosition;
  let nextMatchIndex = 0;
  let stopAssigning = false;
  let requestFailure;
  let storageFailure;
  let acceptanceTail = Promise.resolve();

  function recordRequestFailure(match, cause) {
    if (requestFailure === undefined && storageFailure === undefined) {
      requestFailure = {matchId: match.matchId, cause};
    }
    stopAssigning = true;
  }

  function recordStorageFailure(error) {
    if (storageFailure === undefined) {
      storageFailure = error.cause;
    }
    stopAssigning = true;
  }

  async function acceptResponse(match, response) {
    if (storageFailure !== undefined) {
      throw new StorageFailure('acceptance', storageFailure);
    }

    try {
      validateBattleResult(
        match,
        response,
        plan.metadata.simulatorVersion
      );
    } catch (error) {
      throw new AcceptanceFailure(
        `Battle ${match.matchId} returned an invalid response`,
        error
      );
    }

    if (acceptedThisExecution.has(match.matchId)) {
      throw new AcceptanceFailure(
        `Battle ${match.matchId} was accepted more than once`
      );
    }

    try {
      await appendResult(resultsPath, response);
    } catch (error) {
      throw new StorageFailure('result append', error);
    }

    completedIds.add(match.matchId);
    acceptedThisExecution.add(match.matchId);
    acceptedResultCount++;

    while (schedulePosition < plan.groupSchedule.length &&
        completedIds.has(plan.groupSchedule[schedulePosition].matchId)) {
      schedulePosition++;
    }

    let nextCheckpoint;

    try {
      nextCheckpoint = {
        schemaVersion: 1,
        stage: 'groups',
        round: null,
        schedulePosition,
        acceptedResultCount,
        updatedAt: now(),
      };
      validateCheckpoint(nextCheckpoint);
    } catch (error) {
      throw new StorageFailure('checkpoint construction', error);
    }

    try {
      await writeJson(checkpointPath, nextCheckpoint);
    } catch (error) {
      throw new StorageFailure('checkpoint write', error);
    }
  }

  function queueAcceptance(match, response) {
    const operation = acceptanceTail.then(() =>
      acceptResponse(match, response)
    );

    acceptanceTail = operation.catch(error => {
      if (error instanceof StorageFailure) {
        recordStorageFailure(error);
      } else {
        recordRequestFailure(match, error.cause === undefined
          ? error
          : error.cause);
      }
    });

    return operation;
  }

  async function worker() {
    while (!stopAssigning) {
      const matchIndex = nextMatchIndex;

      if (matchIndex >= plan.missingGroupMatches.length) {
        return;
      }

      nextMatchIndex++;
      const match = plan.missingGroupMatches[matchIndex];
      let response;

      try {
        response = await runBattle(match);
      } catch (error) {
        recordRequestFailure(match, error);
        return;
      }

      try {
        await queueAcceptance(match, response);
      } catch {
        return;
      }
    }
  }

  const workerCount = Math.min(
    plan.metadata.runnerConcurrency,
    plan.missingGroupMatches.length
  );
  await Promise.all(Array.from({length: workerCount}, () => worker()));
  await acceptanceTail;

  if (storageFailure !== undefined) {
    throw storageFailure;
  }

  if (requestFailure !== undefined) {
    const failedMetadata = {
      ...plan.metadata,
      status: 'failed',
      completedAt: null,
    };
    validateRunMetadata(failedMetadata, identity);

    try {
      await writeJson(metadataPath, failedMetadata);
    } catch (error) {
      throw error;
    }

    throw new Error(
      `Group-stage execution stopped after battle ` +
        `"${requestFailure.matchId}" failed`,
      {cause: requestFailure.cause}
    );
  }

  return {
    stage: 'groups',
    requestedMatchCount: nextMatchIndex,
    acceptedMatchCount: acceptedThisExecution.size,
    acceptedResultCount,
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
  executeGroupStagePlan,
  planTournamentRun,
};
