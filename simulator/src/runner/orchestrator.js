'use strict';

const sampleRosterConfiguration = require('../../config/sample_roster.json');
const {initializeOrResumeRun, loadOrCreateRunRoster} = require('../runner-state');
const {selectTournamentRoster, shuffleRoster} = require('../tournament');
const {requireObject} = require('./common');
const {buildRunRoster} = require('./roster');
const {reconstructGroupStage} = require('./group-recovery');
const {buildKnockoutPlanFromReconstruction} = require('./knockout-recovery');
const {executeGroupStagePlan} = require('./group-executor');
const {executeKnockoutPlan} = require('./knockout-executor');

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

  if (runState.roster === undefined) {
    const selectRoster = options.selectRoster === undefined
      ? mode => selectTournamentRoster(
        mode,
        options.sampleRoster === undefined
          ? sampleRosterConfiguration
          : options.sampleRoster
      )
      : options.selectRoster;

    if (typeof selectRoster !== 'function') {
      throw new TypeError('selectRoster must be a function');
    }

    const preparedRoster = await selectRoster(options.identity.mode);
    const {rosterSeed, shuffledRoster} = shuffleRoster(
      preparedRoster,
      options.identity.tournamentSeed
    );
    const requestedRoster = buildRunRoster(
      options.identity,
      rosterSeed,
      shuffledRoster
    );
    const persistedRoster = await loadOrCreateRunRoster({
      runDirectory: runState.runDirectory,
      identity: options.identity,
      roster: requestedRoster,
    });
    runState.roster = persistedRoster.roster;
  }

  const reconstruction = reconstructGroupStage(
    runState,
    options.identity
  );
  const checkpointStage = runState.checkpointHint === undefined
    ? undefined
    : runState.checkpointHint.stage;
  const groupStageComplete =
    reconstruction.plan.missingGroupMatches.length === 0;
  const hasKnockoutEvidence = reconstruction.knockoutRecords.length > 0;

  if (hasKnockoutEvidence && !groupStageComplete) {
    throw new Error(
      `Knockout recovery requires the complete group stage: persisted ` +
        `knockout matchId "${reconstruction.knockoutRecords[0].matchId}" ` +
        'was found before every group result'
    );
  }

  if (hasKnockoutEvidence ||
      (groupStageComplete &&
        (checkpointStage === 'knockout' || checkpointStage === 'complete'))) {
    return buildKnockoutPlanFromReconstruction(
      reconstruction,
      options.identity
    );
  }

  return reconstruction.plan;
}

async function runTournament(options) {
  const onProgress = options.onProgress === undefined
    ? () => {}
    : options.onProgress;

  if (typeof onProgress !== 'function') {
    throw new TypeError('onProgress must be a function');
  }

  while (true) {
    const plan = await planTournamentRun(options);

    if (plan.terminal === true) {
      if (plan.status !== 'completed' && plan.status !== 'failed') {
        throw new Error(
          `Unknown terminal tournament planner status "${String(plan.status)}"`
        );
      }

      return {
        terminal: true,
        stage: plan.status === 'completed' ? 'complete' : 'failed',
        status: plan.status,
        tournamentComplete: plan.status === 'completed',
        runDirectory: plan.runDirectory,
        metadata: plan.metadata,
      };
    }

    if (plan.terminal !== false) {
      throw new Error(
        `Unknown tournament planner action for terminal value ` +
          `"${String(plan.terminal)}"`
      );
    }

    if (plan.stage === 'groups') {
      const progress = await executeGroupStagePlan(plan, options);
      await onProgress(progress);
      continue;
    }

    if (plan.stage === 'knockout') {
      const progress = await executeKnockoutPlan(plan, options);
      await onProgress(progress);
      continue;
    }

    throw new Error(
      `Unknown non-terminal tournament planner stage "${String(plan.stage)}"`
    );
  }
}

module.exports = {
  planTournamentRun,
  runTournament,
};
