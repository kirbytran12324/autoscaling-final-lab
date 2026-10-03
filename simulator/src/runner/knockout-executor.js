'use strict';

const {createAcceptanceQueue} = require('./acceptance');
const {createDiagnostics} = require('./diagnostics');

const {join} = require('node:path');
const {appendJsonLine, atomicWriteJson, validateCheckpoint, validateRunMetadata} = require('../runner-state');
const {validateBattleResult} = require('../simulator-client');
const {buildNextKnockoutRound, evaluateKnockoutSeries, generateKnockoutSeriesGame, selectTournamentChampion} = require('../tournament');
const {validateKnockoutExecutionPlan} = require('./knockout-validation');
const {requireObject, resolveRunBattle} = require('./common');
const {buildKnockoutBracket} = require('./knockout-artifacts');
const {KnockoutStorageFailure, AcceptanceFailure, buildFailureRecord, createAcceptanceFailureHandler} = require('./failures');

async function executeKnockoutPlan(plan, options = {}) {
  const validation = validateKnockoutExecutionPlan(plan);
  requireObject(options, 'Knockout execution options');

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
      'Knockout persistence dependencies and now must be functions'
    );
  }

  const diagnostics = createDiagnostics(options);
  const derivebuildKnockoutBracket = diagnostics.derive(buildKnockoutBracket);
  const derivebuildNextKnockoutRound = diagnostics.derive(buildNextKnockoutRound);
  const deriveselectTournamentChampion = diagnostics.derive(selectTournamentChampion);
  const persistResult = diagnostics.append(appendResult);
  const persistJson = diagnostics.write(writeJson);

  const resultsPath = join(plan.runDirectory, 'results.jsonl');
  const checkpointPath = join(plan.runDirectory, 'checkpoint.json');
  const metadataPath = join(plan.runDirectory, 'run-metadata.json');
  const bracketPath = join(plan.runDirectory, 'bracket.json');
  const failuresPath = join(plan.runDirectory, 'failures.jsonl');
  const activeRound = validation.activeRoundState.round;
  const checkpointHint = plan.checkpointHint;
  const requiresRecoveredBarrier = !validation.activeRoundComplete &&
    (checkpointHint === undefined ||
      checkpointHint.stage !== 'knockout' ||
      checkpointHint.round !== activeRound.round);

  function createCheckpoint(stage, round, schedulePosition, count, updatedAt) {
    const nextCheckpoint = {
      schemaVersion: 1,
      stage,
      round,
      schedulePosition,
      acceptedResultCount: count,
      updatedAt,
    };
    validateCheckpoint(nextCheckpoint);
    return nextCheckpoint;
  }

  if (requiresRecoveredBarrier) {
    const updatedAt = now();
    const bracket = derivebuildKnockoutBracket(plan, validation.roundStates, {
      champion: null,
      enrichActiveRound: false,
      status: 'running',
      updatedAt,
    });
    const recoveredCheckpoint = createCheckpoint(
      'knockout',
      activeRound.round,
      plan.schedulePosition,
      plan.acceptedResultCount,
      updatedAt
    );

    await persistJson(bracketPath, bracket);
    await persistJson(checkpointPath, recoveredCheckpoint);

    return {
      stage: 'knockout',
      round: activeRound.round,
      tournamentComplete: false,
      requestedMatchCount: 0,
      acceptedMatchCount: 0,
      acceptedResultCount: plan.acceptedResultCount,
      schedulePosition: plan.schedulePosition,
    };
  }

  const runBattle = validation.activeRoundComplete
    ? undefined
    : resolveRunBattle(options, 'Knockout-round');
  const requestBattle = runBattle === undefined ? undefined : diagnostics.request(runBattle);
  const activeSeriesStates = validation.activeRoundState.seriesStates;
  const seriesStatesById = new Map(activeSeriesStates.map(state => [
    state.series.seriesId,
    state,
  ]));
  const pendingSeriesStates = plan.nextGameRequests.map(request => {
    const state = seriesStatesById.get(request.seriesId);
    return {
      ...state,
      games: [...state.games],
      evaluation: structuredClone(state.evaluation),
      nextRequest: {...request, seed: [...request.seed]},
    };
  });

  validation.activeRoundState.seriesStates = activeSeriesStates.map(state =>
    pendingSeriesStates.find(candidate =>
      candidate.series.seriesId === state.series.seriesId
    ) || state
  );

  const acceptedThisExecution = new Set();
  const requestedThisExecution = new Set();
  let acceptedResultCount = plan.acceptedResultCount;
  let schedulePosition = plan.schedulePosition;
  let nextSeriesIndex = 0;
  let stopAssigning = false;
  let requestFailure;
  let storageFailure;


  function recordRequestFailure(request, cause) {
    if (requestFailure === undefined && storageFailure === undefined) {
      requestFailure = {request: structuredClone(request), cause};
    }
    stopAssigning = true;
  }

  function recordStorageFailure(error) {
    if (storageFailure === undefined) {
      storageFailure = error.cause;
    }
    stopAssigning = true;
  }

  async function acceptResponse(seriesState, request, response) {
    if (storageFailure !== undefined) {
      throw new KnockoutStorageFailure('acceptance', storageFailure);
    }

    try {
      validateBattleResult(
        request,
        response,
        plan.metadata.simulatorVersion
      );
    } catch (error) {
      throw new AcceptanceFailure(
        `Battle ${request.matchId} returned an invalid response`,
        error
      );
    }

    if (acceptedThisExecution.has(request.matchId)) {
      throw new AcceptanceFailure(
        `Battle ${request.matchId} was accepted more than once`
      );
    }

    const acceptedGame = {
      ...response,
      seriesId: seriesState.series.seriesId,
      gameNumber: request.gameNumber,
    };
    let nextEvaluation;

    try {
      nextEvaluation = evaluateKnockoutSeries(
        seriesState.series,
        [...seriesState.games, acceptedGame],
        plan.metadata.tournamentSeed
      );
    } catch (error) {
      throw new AcceptanceFailure(
        `Battle ${request.matchId} cannot advance its knockout series`,
        error
      );
    }

    try {
      await persistResult(resultsPath, response);
    } catch (error) {
      throw new KnockoutStorageFailure('result append', error);
    }

    seriesState.games.push(acceptedGame);
    seriesState.evaluation = nextEvaluation;
    acceptedThisExecution.add(request.matchId);
    acceptedResultCount++;
    schedulePosition++;

    let nextCheckpoint;

    try {
      nextCheckpoint = createCheckpoint(
        'knockout',
        activeRound.round,
        schedulePosition,
        acceptedResultCount,
        now()
      );
    } catch (error) {
      throw new KnockoutStorageFailure('checkpoint construction', error);
    }

    try {
      await persistJson(checkpointPath, nextCheckpoint);
    } catch (error) {
      throw new KnockoutStorageFailure('checkpoint write', error);
    }

    return nextEvaluation;
  }

  const acceptanceQueue = createAcceptanceQueue({
    accept: (request, response, seriesState) => acceptResponse(seriesState, request, response),
    observe: diagnostics.observe,
    onError: createAcceptanceFailureHandler({
      StorageError: KnockoutStorageFailure,
      onStorageFailure: recordStorageFailure,
      onRequestFailure: recordRequestFailure,
    }),
  });
  const queueAcceptance = (seriesState, request, response) =>
    acceptanceQueue.enqueue(request, response, seriesState);

  async function executeSeries(seriesState) {
    while (!stopAssigning &&
        seriesState.evaluation.status !== 'complete') {
      const request = seriesState.nextRequest;

      if (requestedThisExecution.has(request.matchId)) {
        recordRequestFailure(
          request,
          new Error(`Battle ${request.matchId} was requested more than once`)
        );
        return;
      }

      requestedThisExecution.add(request.matchId);
      let response;

      try {
        response = await requestBattle(request);
      } catch (error) {
        recordRequestFailure(request, error);
        return;
      }

      let evaluation;

      try {
        evaluation = await queueAcceptance(seriesState, request, response);
      } catch {
        return;
      }

      if (stopAssigning || evaluation.status === 'complete') {
        return;
      }

      seriesState.nextRequest = generateKnockoutSeriesGame(
        seriesState.series,
        evaluation.nextGameNumber,
        plan.metadata.tournamentSeed
      );
    }
  }

  async function worker() {
    while (!stopAssigning) {
      const seriesIndex = nextSeriesIndex;

      if (seriesIndex >= pendingSeriesStates.length) {
        return;
      }

      nextSeriesIndex++;
      await executeSeries(pendingSeriesStates[seriesIndex]);
    }
  }

  if (!validation.activeRoundComplete) {
    const workerCount = Math.min(
      plan.metadata.runnerConcurrency,
      pendingSeriesStates.length
    );
    await Promise.all(Array.from({length: workerCount}, () => worker()));
    await acceptanceQueue.drain();
  }

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
      validation.identity,
      requestFailure.request,
      'knockout',
      activeRound.round,
      now(),
      requestFailure.cause
    );
    await appendFailure(failuresPath, failureRecord);

    const failedMetadata = {
      ...plan.metadata,
      status: 'failed',
      completedAt: null,
    };
    validateRunMetadata(failedMetadata, validation.identity);
    await persistJson(metadataPath, failedMetadata);

    throw new Error(
      `Knockout execution stopped after battle ` +
        `"${requestFailure.request.matchId}" failed`,
      {cause: requestFailure.cause}
    );
  }

  const completedEvaluations = validation.activeRoundState.seriesStates
    .map(state => state.evaluation);

  if (!completedEvaluations.every(evaluation =>
    evaluation.status === 'complete'
  )) {
    throw new Error(
      `Knockout round ${activeRound.round} stopped before every series completed`
    );
  }

  const updatedAt = now();

  if (activeRound.round !== 'r2') {
    const nextRound = derivebuildNextKnockoutRound(
      activeRound,
      completedEvaluations
    );
    const bracket = derivebuildKnockoutBracket(plan, validation.roundStates, {
      champion: null,
      enrichActiveRound: true,
      nextRound,
      status: 'running',
      updatedAt,
    });
    const nextCheckpoint = createCheckpoint(
      'knockout',
      nextRound.round,
      0,
      acceptedResultCount,
      updatedAt
    );

    await persistJson(bracketPath, bracket);
    await persistJson(checkpointPath, nextCheckpoint);

    return {
      stage: 'knockout',
      round: nextRound.round,
      tournamentComplete: false,
      requestedMatchCount: requestedThisExecution.size,
      acceptedMatchCount: acceptedThisExecution.size,
      acceptedResultCount,
      schedulePosition: 0,
    };
  }

  const champion = deriveselectTournamentChampion(
    activeRound,
    validation.activeRoundState.seriesStates[0].games,
    plan.metadata.tournamentSeed
  );
  const bracket = derivebuildKnockoutBracket(plan, validation.roundStates, {
    champion,
    enrichActiveRound: true,
    status: 'completed',
    updatedAt,
  });
  const completeCheckpoint = createCheckpoint(
    'complete',
    activeRound.round,
    schedulePosition,
    acceptedResultCount,
    updatedAt
  );
  const completedMetadata = {
    ...plan.metadata,
    status: 'completed',
    completedAt: updatedAt,
  };
  validateRunMetadata(completedMetadata, validation.identity);

  await persistJson(bracketPath, bracket);
  await persistJson(checkpointPath, completeCheckpoint);
  await persistJson(metadataPath, completedMetadata);

  return {
    stage: 'complete',
    round: activeRound.round,
    tournamentComplete: true,
    champion,
    requestedMatchCount: requestedThisExecution.size,
    acceptedMatchCount: acceptedThisExecution.size,
    acceptedResultCount,
    schedulePosition,
  };
}

module.exports = {
  executeKnockoutPlan,
};
