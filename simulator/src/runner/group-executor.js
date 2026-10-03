'use strict';

const {createAcceptanceQueue} = require('./acceptance');
const {createDiagnostics} = require('./diagnostics');

const {join} = require('node:path');
const {appendJsonLine, atomicWriteJson, validateCheckpoint, validateRunMetadata} = require('../runner-state');
const {validateBattleResult} = require('../simulator-client');
const {validateExecutionPlan} = require('./group-validation');
const {PROVISIONAL_CADENCE} = require('./constants');
const {requireObject, resolveRunBattle} = require('./common');
const {buildGroupStandingsArtifact, buildInitialKnockoutArtifact} = require('./group-artifacts');
const {StorageFailure, AcceptanceFailure, buildFailureRecord, createAcceptanceFailureHandler} = require('./failures');

async function executeGroupStagePlan(plan, options = {}) {
  const {
    acceptedRecordsByMatchId,
    completedIds,
    expectedResultCount,
    identity,
  } = validateExecutionPlan(plan);
  const cadence = PROVISIONAL_CADENCE[plan.metadata.mode];
  const requiresFinalTransition =
    plan.acceptedResultCount === expectedResultCount;
  const requiresRecoveredSnapshot = plan.acceptedResultCount > 0 &&
    plan.acceptedResultCount < expectedResultCount &&
    plan.acceptedResultCount % cadence === 0;

  if (plan.missingGroupMatches.length === 0 &&
      !requiresFinalTransition && !requiresRecoveredSnapshot) {
    return {
      stage: 'groups',
      requestedMatchCount: 0,
      acceptedMatchCount: 0,
      acceptedResultCount: plan.acceptedResultCount,
      schedulePosition: plan.schedulePosition,
    };
  }

  requireObject(options, 'Group-stage execution options');

  const runBattle = plan.missingGroupMatches.length === 0
    ? undefined
    : resolveRunBattle(options);
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

  const diagnostics = createDiagnostics(options);
  const derivebuildGroupStandingsArtifact = diagnostics.derive(buildGroupStandingsArtifact);
  const derivebuildInitialKnockoutArtifact = diagnostics.derive(buildInitialKnockoutArtifact);
  const persistResult = diagnostics.append(appendResult);
  const persistJson = diagnostics.write(writeJson);
  const requestBattle = runBattle === undefined ? undefined : diagnostics.request(runBattle);

  const resultsPath = join(plan.runDirectory, 'results.jsonl');
  const checkpointPath = join(plan.runDirectory, 'checkpoint.json');
  const metadataPath = join(plan.runDirectory, 'run-metadata.json');
  const standingsPath = join(plan.runDirectory, 'standings.json');
  const bracketPath = join(plan.runDirectory, 'bracket.json');
  const failuresPath = join(plan.runDirectory, 'failures.jsonl');
  const acceptedThisExecution = new Set();
  let acceptedResultCount = plan.acceptedResultCount;
  let schedulePosition = plan.schedulePosition;
  let nextMatchIndex = 0;
  let stopAssigning = false;
  let requestFailure;
  let storageFailure;


  function createGroupCheckpoint() {
    const checkpoint = {
      schemaVersion: 1,
      stage: 'groups',
      round: null,
      schedulePosition,
      acceptedResultCount,
      updatedAt: now(),
    };
    validateCheckpoint(checkpoint);
    return checkpoint;
  }

  async function writeProvisionalStandings(updatedAt) {
    const provisionalStandings = derivebuildGroupStandingsArtifact(
      plan,
      acceptedRecordsByMatchId,
      'provisional',
      updatedAt
    );
    await persistJson(standingsPath, provisionalStandings);
  }

  function recordRequestFailure(match, cause) {
    if (requestFailure === undefined && storageFailure === undefined) {
      requestFailure = {request: structuredClone(match), cause};
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
      await persistResult(resultsPath, response);
    } catch (error) {
      throw new StorageFailure('result append', error);
    }

    completedIds.add(match.matchId);
    acceptedThisExecution.add(match.matchId);
    acceptedRecordsByMatchId.set(match.matchId, response);
    acceptedResultCount++;

    while (schedulePosition < plan.groupSchedule.length &&
        completedIds.has(plan.groupSchedule[schedulePosition].matchId)) {
      schedulePosition++;
    }

    let nextCheckpoint;

    try {
      nextCheckpoint = createGroupCheckpoint();
    } catch (error) {
      throw new StorageFailure('checkpoint construction', error);
    }

    try {
      await persistJson(checkpointPath, nextCheckpoint);
    } catch (error) {
      throw new StorageFailure('checkpoint write', error);
    }

    if (acceptedResultCount < expectedResultCount &&
        acceptedResultCount % cadence === 0) {
      try {
        await writeProvisionalStandings(nextCheckpoint.updatedAt);
      } catch (error) {
        throw new StorageFailure('provisional standings write', error);
      }
    }
  }

  const acceptanceQueue = createAcceptanceQueue({
    accept: acceptResponse,
    observe: diagnostics.observe,
    onError: createAcceptanceFailureHandler({
      StorageError: StorageFailure,
      onStorageFailure: recordStorageFailure,
      onRequestFailure: recordRequestFailure,
    }),
  });
  const queueAcceptance = (match, response) => acceptanceQueue.enqueue(match, response);

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
        response = await requestBattle(match);
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

  if (requiresRecoveredSnapshot) {
    let recoveredCheckpoint;

    try {
      recoveredCheckpoint = createGroupCheckpoint();
      await persistJson(checkpointPath, recoveredCheckpoint);
    } catch (error) {
      throw error;
    }

    try {
      await writeProvisionalStandings(recoveredCheckpoint.updatedAt);
    } catch (error) {
      throw error;
    }
  }

  if (plan.missingGroupMatches.length === 0 && !requiresFinalTransition) {
    return {
      stage: 'groups',
      requestedMatchCount: 0,
      acceptedMatchCount: 0,
      acceptedResultCount,
      schedulePosition,
    };
  }

  const workerCount = Math.min(
    plan.metadata.runnerConcurrency,
    plan.missingGroupMatches.length
  );
  await Promise.all(Array.from({length: workerCount}, () => worker()));
  await acceptanceQueue.drain();

  if (storageFailure !== undefined) {
    throw storageFailure;
  }

  if (requestFailure !== undefined) {
    const appendFailure = options.appendFailureJsonLine === undefined
      ? appendJsonLine
      : options.appendFailureJsonLine;

    if (typeof appendFailure !== 'function') {
      throw new TypeError('appendFailureJsonLine must be a function');
    }

    const failureRecord = buildFailureRecord(
      identity,
      requestFailure.request,
      'groups',
      null,
      now(),
      requestFailure.cause
    );
    await appendFailure(failuresPath, failureRecord);

    const failedMetadata = {
      ...plan.metadata,
      status: 'failed',
      completedAt: null,
    };
    validateRunMetadata(failedMetadata, identity);

    try {
      await persistJson(metadataPath, failedMetadata);
    } catch (error) {
      throw error;
    }

    throw new Error(
      `Group-stage execution stopped after battle ` +
        `"${requestFailure.request.matchId}" failed`,
      {cause: requestFailure.cause}
    );
  }

  if (acceptedResultCount === expectedResultCount) {
    let transitionCheckpoint;
    let finalStandings;
    let bracket;

    try {
      const updatedAt = now();
      transitionCheckpoint = {
        schemaVersion: 1,
        stage: 'knockout',
        round: plan.metadata.mode === 'sample' ? 'r16' : 'r64',
        schedulePosition: 0,
        acceptedResultCount,
        updatedAt,
      };
      validateCheckpoint(transitionCheckpoint);
      finalStandings = derivebuildGroupStandingsArtifact(
        plan,
        acceptedRecordsByMatchId,
        'final',
        updatedAt
      );
      bracket = derivebuildInitialKnockoutArtifact(
        plan,
        finalStandings,
        updatedAt
      );
    } catch (error) {
      throw error;
    }

    try {
      await persistJson(standingsPath, finalStandings);
    } catch (error) {
      throw error;
    }

    try {
      await persistJson(bracketPath, bracket);
    } catch (error) {
      throw error;
    }

    try {
      await persistJson(checkpointPath, transitionCheckpoint);
    } catch (error) {
      throw error;
    }

    return {
      stage: 'knockout',
      round: transitionCheckpoint.round,
      requestedMatchCount: nextMatchIndex,
      acceptedMatchCount: acceptedThisExecution.size,
      acceptedResultCount,
      schedulePosition: 0,
    };
  }

  return {
    stage: 'groups',
    requestedMatchCount: nextMatchIndex,
    acceptedMatchCount: acceptedThisExecution.size,
    acceptedResultCount,
    schedulePosition,
  };
}

module.exports = {
  executeGroupStagePlan,
};
