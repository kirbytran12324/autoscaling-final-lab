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
  FULL_ADVANCERS_PER_GROUP,
  FULL_GROUP_SIZES,
  KNOCKOUT_SERIES_COUNTS,
  NEXT_KNOCKOUT_ROUND,
  SAMPLE_ADVANCERS_PER_GROUP,
  SAMPLE_GROUP_SIZES,
  buildFullRoster,
  buildInitialKnockoutRound,
  buildNextKnockoutRound,
  buildSampleRoster,
  calculateGroupStandings,
  evaluateKnockoutSeries,
  generateGroupStageSchedule,
  generateKnockoutSeriesGame,
  selectAdvancers,
  selectTournamentChampion,
  shuffleRoster,
  splitRosterIntoGroups,
} = require('./tournament');

const GROUP_NAMES = Object.freeze(['A', 'B', 'C', 'D']);
const PROVISIONAL_CADENCE = Object.freeze({
  sample: 10,
  full: 1000,
});
const KNOCKOUT_MATCH_ID_PATTERN =
  /^(r\d+)-series-(\d{2})-game-(\d{2})$/;

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

function reconstructGroupStage(
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
  identity,
  configuredSampleRoster = sampleRosterConfiguration
) {
  const reconstruction = reconstructGroupStage(
    runState,
    identity,
    configuredSampleRoster
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

function expectedGroupResultCount(groups) {
  requireObject(groups, 'Execution plan groups');

  return GROUP_NAMES.reduce((total, groupName) => {
    const group = groups[groupName];

    if (!Array.isArray(group)) {
      throw new TypeError(`Execution plan group ${groupName} must be an array`);
    }

    return total + group.length * (group.length - 1) / 2;
  }, 0);
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
      !Array.isArray(plan.completedMatchIds) ||
      !Array.isArray(plan.validatedRecords)) {
    throw new TypeError(
      'Execution plan schedule, records, missing matches, and completed IDs ' +
        'must be arrays'
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

  const acceptedRecordsByMatchId = new Map();

  for (const record of plan.validatedRecords) {
    requireObject(record, 'Validated group result');
    const scheduledRequest = scheduleByMatchId.get(record.matchId);

    if (scheduledRequest === undefined || !completedIds.has(record.matchId)) {
      throw new Error(
        `Validated record "${record.matchId}" is not a completed scheduled match`
      );
    }

    validateBattleResult(
      scheduledRequest,
      record,
      plan.metadata.simulatorVersion
    );

    if (acceptedRecordsByMatchId.has(record.matchId)) {
      throw new Error(`Duplicate validated record "${record.matchId}"`);
    }

    acceptedRecordsByMatchId.set(record.matchId, record);
  }

  if (acceptedRecordsByMatchId.size !== completedIds.size) {
    throw new Error(
      'Execution plan validated records do not match completed match IDs'
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

  return {
    acceptedRecordsByMatchId,
    completedIds,
    expectedResultCount: expectedGroupResultCount(plan.groups),
    identity,
    scheduleByMatchId,
  };
}

function buildGroupStandingsArtifact(
  plan,
  acceptedRecordsByMatchId,
  status,
  updatedAt
) {
  if (!(acceptedRecordsByMatchId instanceof Map)) {
    throw new TypeError('Accepted group records must be a Map');
  }

  if (status !== 'provisional' && status !== 'final') {
    throw new TypeError('Standings status must be provisional or final');
  }

  const expectedResultCount = expectedGroupResultCount(plan.groups);
  const scheduleByMatchId = buildScheduleLookup(plan.groupSchedule);
  const resultsByGroup = new Map(
    GROUP_NAMES.map(groupName => [groupName, []])
  );

  for (const [matchId, record] of acceptedRecordsByMatchId) {
    const scheduledRequest = scheduleByMatchId.get(matchId);

    if (scheduledRequest === undefined) {
      throw new Error(
        `Accepted record "${matchId}" has no scheduled group match`
      );
    }

    validateBattleResult(
      scheduledRequest,
      record,
      plan.metadata.simulatorVersion
    );
    resultsByGroup.get(scheduledRequest.group).push({
      ...record,
      group: scheduledRequest.group,
    });
  }

  if (status === 'final' &&
      acceptedRecordsByMatchId.size !== expectedResultCount) {
    throw new RangeError(
      `Final standings require ${expectedResultCount} accepted group results; ` +
        `received ${acceptedRecordsByMatchId.size}`
    );
  }

  const groups = GROUP_NAMES.map(groupName =>
    calculateGroupStandings(
      groupName,
      plan.groups[groupName],
      resultsByGroup.get(groupName),
      plan.metadata.tournamentSeed,
      {requireComplete: status === 'final'}
    )
  );

  if (status === 'final' && groups.some(group => group.status !== 'final')) {
    throw new RangeError('Final standings require every group to be complete');
  }

  const advancingCount = plan.metadata.mode === 'sample'
    ? SAMPLE_ADVANCERS_PER_GROUP
    : FULL_ADVANCERS_PER_GROUP;

  return {
    schemaVersion: 1,
    runId: plan.metadata.runId,
    status,
    acceptedResultCount: acceptedRecordsByMatchId.size,
    expectedResultCount,
    advancingCount,
    updatedAt,
    groups,
  };
}

function buildInitialKnockoutArtifact(plan, finalStandings, updatedAt) {
  requireObject(finalStandings, 'Final standings artifact');
  const advancingCount = plan.metadata.mode === 'sample'
    ? SAMPLE_ADVANCERS_PER_GROUP
    : FULL_ADVANCERS_PER_GROUP;

  if (finalStandings.status !== 'final' ||
      finalStandings.runId !== plan.metadata.runId ||
      !Array.isArray(finalStandings.groups) ||
      finalStandings.groups.length !== GROUP_NAMES.length ||
      finalStandings.groups.some((group, index) =>
        group.group !== GROUP_NAMES[index]
      ) ||
      finalStandings.advancingCount !== advancingCount ||
      finalStandings.acceptedResultCount !==
        finalStandings.expectedResultCount ||
      finalStandings.expectedResultCount !==
        expectedGroupResultCount(plan.groups)) {
    throw new Error(
      'Initial knockout construction requires complete final standings'
    );
  }

  const groupAdvancers = finalStandings.groups.map(groupStanding =>
    selectAdvancers(groupStanding, finalStandings.advancingCount)
  );
  const initialRound = buildInitialKnockoutRound(groupAdvancers);

  return {
    schemaVersion: 1,
    runId: plan.metadata.runId,
    status: 'running',
    rounds: [initialRound],
    champion: null,
    updatedAt,
  };
}

function parseKnockoutRecord(record, mode, roundOrder) {
  const match = KNOCKOUT_MATCH_ID_PATTERN.exec(record.matchId);

  if (match === null) {
    throw new Error(`Invalid knockout matchId "${record.matchId}"`);
  }

  const [, round, seriesDigits, gameDigits] = match;

  if (!roundOrder.includes(round)) {
    throw new Error(
      `Unexpected knockout round "${round}" for ${mode} tournament ` +
        `matchId "${record.matchId}"`
    );
  }

  const seriesPosition = Number(seriesDigits);
  if (seriesPosition < 1 ||
      seriesPosition > KNOCKOUT_SERIES_COUNTS[round]) {
    throw new Error(
      `Unknown knockout series "${round}-series-${seriesDigits}" in ` +
        `persisted matchId "${record.matchId}"`
    );
  }

  const gameNumber = Number(gameDigits);
  if (gameNumber < 1 || gameNumber > 7) {
    throw new Error(
      `Invalid knockout game number ${gameDigits} in persisted matchId ` +
        `"${record.matchId}"`
    );
  }

  return {
    record,
    round,
    seriesId: `${round}-series-${seriesDigits}`,
    seriesPosition,
    gameNumber,
  };
}

function validatePersistedKnockoutGame(
  series,
  descriptor,
  identity
) {
  const expectedRequest = generateKnockoutSeriesGame(
    series,
    descriptor.gameNumber,
    identity.tournamentSeed
  );

  try {
    validateBattleResult(
      expectedRequest,
      descriptor.record,
      identity.simulatorVersion
    );
  } catch (error) {
    throw new Error(
      `Persisted knockout record "${descriptor.record.matchId}" conflicts ` +
        `with its expected request: ${error.message}`,
      {cause: error}
    );
  }

  return {
    ...descriptor.record,
    seriesId: descriptor.seriesId,
    gameNumber: descriptor.gameNumber,
  };
}

function buildKnockoutPlanFromReconstruction(
  reconstruction,
  identity
) {
  const groupPlan = reconstruction.plan;
  const expectedGroupCount = expectedGroupResultCount(groupPlan.groups);

  if (groupPlan.acceptedResultCount !== expectedGroupCount ||
      groupPlan.missingGroupMatches.length !== 0) {
    throw new Error(
      `Knockout recovery requires the complete group stage: expected ` +
        `${expectedGroupCount} accepted group results, received ` +
        `${groupPlan.acceptedResultCount}`
    );
  }

  const groupRecordsByMatchId = new Map(
    groupPlan.validatedRecords.map(record => [record.matchId, record])
  );
  const artifactTimestamp = groupPlan.metadata.startedAt;
  const finalStandings = buildGroupStandingsArtifact(
    groupPlan,
    groupRecordsByMatchId,
    'final',
    artifactTimestamp
  );
  const initialBracket = buildInitialKnockoutArtifact(
    groupPlan,
    finalStandings,
    artifactTimestamp
  );
  const roundOrder = [];
  let roundName = initialBracket.rounds[0].round;

  while (roundName !== undefined) {
    roundOrder.push(roundName);
    roundName = NEXT_KNOCKOUT_ROUND[roundName];
  }

  const descriptorsByRound = new Map(
    roundOrder.map(round => [round, []])
  );
  const knockoutMatchIds = new Set();

  for (const [acceptedOrder, record] of
    reconstruction.knockoutRecords.entries()) {
    const descriptor = {
      ...parseKnockoutRecord(record, identity.mode, roundOrder),
      acceptedOrder,
    };

    if (knockoutMatchIds.has(record.matchId)) {
      throw new Error(
        `Run state contains duplicate canonical matchId "${record.matchId}"`
      );
    }

    knockoutMatchIds.add(record.matchId);
    descriptorsByRound.get(descriptor.round).push(descriptor);
  }

  const rounds = [initialBracket.rounds[0]];
  const roundEvaluations = [];
  const seriesEvaluations = [];
  const completedSeriesEvaluations = [];
  const validatedKnockoutRecords = [];
  let currentRound = rounds[0];
  let currentRoundAcceptedCount = 0;

  while (true) {
    const currentRoundIndex = roundOrder.indexOf(currentRound.round);
    const seriesById = new Map(currentRound.series.map(series => [
      series.seriesId,
      series,
    ]));
    const descriptorsBySeries = new Map(
      currentRound.series.map(series => [series.seriesId, []])
    );

    for (const descriptor of descriptorsByRound.get(currentRound.round)) {
      if (!seriesById.has(descriptor.seriesId)) {
        throw new Error(
          `Unknown knockout series "${descriptor.seriesId}" in persisted ` +
            `matchId "${descriptor.record.matchId}"`
        );
      }

      descriptorsBySeries.get(descriptor.seriesId).push(descriptor);
    }

    const currentEvaluations = [];
    currentRoundAcceptedCount = 0;

    for (const series of currentRound.series) {
      const persistedDescriptors = descriptorsBySeries.get(series.seriesId);

      for (const [index, descriptor] of persistedDescriptors.entries()) {
        const expectedGameNumber = index + 1;

        if (descriptor.gameNumber !== expectedGameNumber) {
          const expectedAppearsLater = persistedDescriptors
            .slice(index + 1)
            .some(later => later.gameNumber === expectedGameNumber);

          if (expectedAppearsLater) {
            throw new Error(
              `Out-of-order knockout game in series "${series.seriesId}": ` +
                `game ${descriptor.gameNumber} appears before game ` +
                `${expectedGameNumber}`
            );
          }

          throw new Error(
            `Skipped knockout game in series "${series.seriesId}": ` +
              `expected game ${expectedGameNumber}, found game ` +
              `${descriptor.gameNumber}`
          );
        }
      }

      const descriptors = [...persistedDescriptors]
        .sort((left, right) => left.gameNumber - right.gameNumber);
      const acceptedGames = [];

      for (const descriptor of descriptors) {
        const acceptedGame = validatePersistedKnockoutGame(
          series,
          descriptor,
          identity
        );
        acceptedGames.push(acceptedGame);
        validatedKnockoutRecords.push(descriptor.record);
      }

      let evaluation;

      try {
        evaluation = evaluateKnockoutSeries(
          series,
          acceptedGames,
          identity.tournamentSeed
        );
      } catch (error) {
        throw new Error(
          `Invalid persisted games for knockout series ` +
            `"${series.seriesId}": ${error.message}`,
          {cause: error}
        );
      }

      currentRoundAcceptedCount += acceptedGames.length;
      currentEvaluations.push(evaluation);
      seriesEvaluations.push(evaluation);

      if (evaluation.status === 'complete') {
        completedSeriesEvaluations.push(evaluation);
      }
    }

    roundEvaluations.push({
      round: currentRound.round,
      seriesEvaluations: currentEvaluations,
    });

    const roundComplete = currentEvaluations.every(evaluation =>
      evaluation.status === 'complete'
    );

    if (!roundComplete) {
      const futureDescriptor = roundOrder
        .slice(currentRoundIndex + 1)
        .flatMap(round => descriptorsByRound.get(round))[0];

      if (futureDescriptor !== undefined) {
        throw new Error(
          `Persisted future-round game "${futureDescriptor.record.matchId}" ` +
            `cannot be derived until round ${currentRound.round} is complete`
        );
      }

      const nextGameRequests = currentRound.series.flatMap((series, index) => {
        const evaluation = currentEvaluations[index];

        return evaluation.status === 'complete'
          ? []
          : [generateKnockoutSeriesGame(
            series,
            evaluation.nextGameNumber,
            identity.tournamentSeed
          )];
      });

      return {
        terminal: false,
        stage: 'knockout',
        round: currentRound.round,
        activeRound: currentRound.round,
        tournamentComplete: false,
        champion: null,
        identity: {...identity},
        runDirectory: groupPlan.runDirectory,
        metadata: groupPlan.metadata,
        checkpointHint: groupPlan.checkpointHint,
        resumed: groupPlan.resumed,
        rosterSeed: groupPlan.rosterSeed,
        roster: groupPlan.roster,
        groups: groupPlan.groups,
        groupSchedule: groupPlan.groupSchedule,
        finalStandings,
        rounds,
        roundEvaluations,
        seriesEvaluations,
        completedSeriesEvaluations,
        nextGameRequests,
        validatedGroupRecords: groupPlan.validatedRecords,
        validatedKnockoutRecords,
        completedMatchIds: [
          ...groupPlan.completedMatchIds,
          ...validatedKnockoutRecords.map(record => record.matchId),
        ],
        acceptedGroupResultCount: groupPlan.acceptedResultCount,
        acceptedKnockoutResultCount: validatedKnockoutRecords.length,
        acceptedResultCount:
          groupPlan.acceptedResultCount + validatedKnockoutRecords.length,
        schedulePosition: currentRoundAcceptedCount,
      };
    }

    const futureDescriptors = roundOrder
      .slice(currentRoundIndex + 1)
      .flatMap(round => descriptorsByRound.get(round));
    const latestCurrentAcceptedOrder = Math.max(
      ...descriptorsByRound.get(currentRound.round)
        .map(descriptor => descriptor.acceptedOrder)
    );
    const prematureFutureDescriptor = futureDescriptors.find(descriptor =>
      descriptor.acceptedOrder < latestCurrentAcceptedOrder
    );

    if (prematureFutureDescriptor !== undefined) {
      throw new Error(
        `Persisted future-round game ` +
          `"${prematureFutureDescriptor.record.matchId}" appears before ` +
          `the ${currentRound.round} completion barrier`
      );
    }

    if (currentRound.round === 'r2') {
      const finalDescriptors = descriptorsBySeries.get('r2-series-01')
        .sort((left, right) => left.gameNumber - right.gameNumber);
      const finalGames = finalDescriptors.map(descriptor => ({
        ...descriptor.record,
        seriesId: descriptor.seriesId,
        gameNumber: descriptor.gameNumber,
      }));
      const champion = selectTournamentChampion(
        currentRound,
        finalGames,
        identity.tournamentSeed
      );

      return {
        terminal: false,
        stage: 'knockout',
        round: currentRound.round,
        activeRound: currentRound.round,
        tournamentComplete: false,
        resultComplete: true,
        champion,
        identity: {...identity},
        runDirectory: groupPlan.runDirectory,
        metadata: groupPlan.metadata,
        checkpointHint: groupPlan.checkpointHint,
        resumed: groupPlan.resumed,
        rosterSeed: groupPlan.rosterSeed,
        roster: groupPlan.roster,
        groups: groupPlan.groups,
        groupSchedule: groupPlan.groupSchedule,
        finalStandings,
        rounds,
        roundEvaluations,
        seriesEvaluations,
        completedSeriesEvaluations,
        nextGameRequests: [],
        validatedGroupRecords: groupPlan.validatedRecords,
        validatedKnockoutRecords,
        completedMatchIds: [
          ...groupPlan.completedMatchIds,
          ...validatedKnockoutRecords.map(record => record.matchId),
        ],
        acceptedGroupResultCount: groupPlan.acceptedResultCount,
        acceptedKnockoutResultCount: validatedKnockoutRecords.length,
        acceptedResultCount:
          groupPlan.acceptedResultCount + validatedKnockoutRecords.length,
        schedulePosition: currentRoundAcceptedCount,
      };
    }

    currentRound = buildNextKnockoutRound(
      currentRound,
      currentEvaluations
    );
    rounds.push(currentRound);
  }
}

function buildKnockoutRecoveryPlan(
  runState,
  identity,
  configuredSampleRoster = sampleRosterConfiguration
) {
  return buildKnockoutPlanFromReconstruction(
    reconstructGroupStage(runState, identity, configuredSampleRoster),
    identity
  );
}

function resolveRunBattle(options, stage = 'Group-stage') {
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
    `${stage} execution requires runBattle or a simulator client`
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

  const resultsPath = join(plan.runDirectory, 'results.jsonl');
  const checkpointPath = join(plan.runDirectory, 'checkpoint.json');
  const metadataPath = join(plan.runDirectory, 'run-metadata.json');
  const standingsPath = join(plan.runDirectory, 'standings.json');
  const bracketPath = join(plan.runDirectory, 'bracket.json');
  const acceptedThisExecution = new Set();
  let acceptedResultCount = plan.acceptedResultCount;
  let schedulePosition = plan.schedulePosition;
  let nextMatchIndex = 0;
  let stopAssigning = false;
  let requestFailure;
  let storageFailure;
  let acceptanceTail = Promise.resolve();

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
    const provisionalStandings = buildGroupStandingsArtifact(
      plan,
      acceptedRecordsByMatchId,
      'provisional',
      updatedAt
    );
    await writeJson(standingsPath, provisionalStandings);
  }

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
      await writeJson(checkpointPath, nextCheckpoint);
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

  if (requiresRecoveredSnapshot) {
    let recoveredCheckpoint;

    try {
      recoveredCheckpoint = createGroupCheckpoint();
      await writeJson(checkpointPath, recoveredCheckpoint);
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
      finalStandings = buildGroupStandingsArtifact(
        plan,
        acceptedRecordsByMatchId,
        'final',
        updatedAt
      );
      bracket = buildInitialKnockoutArtifact(
        plan,
        finalStandings,
        updatedAt
      );
    } catch (error) {
      throw error;
    }

    try {
      await writeJson(standingsPath, finalStandings);
    } catch (error) {
      throw error;
    }

    try {
      await writeJson(bracketPath, bracket);
    } catch (error) {
      throw error;
    }

    try {
      await writeJson(checkpointPath, transitionCheckpoint);
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

function rawKnockoutSeries(series) {
  return {
    seriesId: series.seriesId,
    position: series.position,
    entrant1: {...series.entrant1},
    entrant2: {...series.entrant2},
  };
}

function rawKnockoutRound(round) {
  return {
    round: round.round,
    series: round.series.map(rawKnockoutSeries),
  };
}

function enrichKnockoutRound(roundState) {
  return {
    round: roundState.round.round,
    series: roundState.seriesStates.map(seriesState => ({
      ...rawKnockoutSeries(seriesState.series),
      games: seriesState.games.map(game => {
        const {seriesId, ...bracketGame} = game;
        return bracketGame;
      }),
      evaluation: structuredClone(seriesState.evaluation),
    })),
  };
}

function validateKnockoutExecutionPlan(plan) {
  requireObject(plan, 'Knockout execution plan');

  if (plan.terminal !== false || plan.stage !== 'knockout' ||
      plan.tournamentComplete !== false) {
    throw new Error(
      'Knockout execution requires a non-terminal, incomplete knockout plan'
    );
  }

  requireObject(plan.metadata, 'Knockout plan metadata');
  requireObject(plan.identity, 'Knockout plan identity');
  validateRunMetadata(plan.metadata, plan.identity);
  const identity = identityFromMetadata(plan.metadata);

  if (plan.metadata.status !== 'running') {
    throw new Error('Knockout execution requires running metadata');
  }

  if (typeof plan.runDirectory !== 'string' ||
      plan.runDirectory.trim() === '') {
    throw new TypeError(
      'Knockout execution plan runDirectory must be a non-empty string'
    );
  }

  for (const [field, value] of [
    ['rounds', plan.rounds],
    ['roundEvaluations', plan.roundEvaluations],
    ['seriesEvaluations', plan.seriesEvaluations],
    ['completedSeriesEvaluations', plan.completedSeriesEvaluations],
    ['nextGameRequests', plan.nextGameRequests],
    ['validatedGroupRecords', plan.validatedGroupRecords],
    ['validatedKnockoutRecords', plan.validatedKnockoutRecords],
  ]) {
    if (!Array.isArray(value)) {
      throw new TypeError(`Knockout execution plan ${field} must be an array`);
    }
  }

  if (plan.rounds.length === 0 ||
      plan.roundEvaluations.length !== plan.rounds.length) {
    throw new Error(
      'Knockout execution plan rounds and evaluations are inconsistent'
    );
  }

  const activeRoundIndex = plan.rounds.length - 1;
  const activeRound = plan.rounds[activeRoundIndex];

  if (!activeRound || activeRound.round !== plan.round ||
      plan.activeRound !== plan.round || !Array.isArray(activeRound.series)) {
    throw new Error('Knockout execution plan active round is inconsistent');
  }

  const knownSeries = new Map();

  for (const round of plan.rounds) {
    requireObject(round, 'Knockout plan round');

    if (!Array.isArray(round.series)) {
      throw new TypeError(`Knockout round ${round.round} series must be an array`);
    }

    for (const series of round.series) {
      if (knownSeries.has(series.seriesId)) {
        throw new Error(`Duplicate knockout series "${series.seriesId}"`);
      }

      knownSeries.set(series.seriesId, series);
    }
  }

  const recordsBySeries = new Map(
    [...knownSeries.keys()].map(seriesId => [seriesId, []])
  );

  for (const record of plan.validatedKnockoutRecords) {
    requireObject(record, 'Validated knockout record');
    const match = KNOCKOUT_MATCH_ID_PATTERN.exec(record.matchId);

    if (match === null) {
      throw new Error(`Invalid knockout matchId "${record.matchId}"`);
    }

    const seriesId = `${match[1]}-series-${match[2]}`;
    const series = knownSeries.get(seriesId);

    if (series === undefined) {
      throw new Error(
        `Validated knockout record has unknown series "${seriesId}"`
      );
    }

    const gameNumber = Number(match[3]);
    const expectedRequest = generateKnockoutSeriesGame(
      series,
      gameNumber,
      identity.tournamentSeed
    );
    validateBattleResult(
      expectedRequest,
      record,
      identity.simulatorVersion
    );
    recordsBySeries.get(seriesId).push({
      ...record,
      seriesId,
      gameNumber,
    });
  }

  const roundStates = [];
  const calculatedEvaluations = [];
  const calculatedCompletedEvaluations = [];

  for (const [roundIndex, round] of plan.rounds.entries()) {
    const evaluationContainer = plan.roundEvaluations[roundIndex];

    if (!evaluationContainer || evaluationContainer.round !== round.round ||
        !Array.isArray(evaluationContainer.seriesEvaluations) ||
        evaluationContainer.seriesEvaluations.length !== round.series.length) {
      throw new Error(
        `Knockout execution plan evaluations for ${round.round} are invalid`
      );
    }

    const seriesStates = round.series.map((series, seriesIndex) => {
      const games = recordsBySeries.get(series.seriesId)
        .sort((left, right) => left.gameNumber - right.gameNumber);

      for (const [gameIndex, game] of games.entries()) {
        if (game.gameNumber !== gameIndex + 1) {
          throw new Error(
            `Knockout execution plan has invalid games for ` +
              `"${series.seriesId}"`
          );
        }
      }

      const evaluation = evaluateKnockoutSeries(
        series,
        games,
        identity.tournamentSeed
      );

      if (!isDeepStrictEqual(
        evaluation,
        evaluationContainer.seriesEvaluations[seriesIndex]
      )) {
        throw new Error(
          `Knockout execution plan evaluation for ` +
            `"${series.seriesId}" is inconsistent`
        );
      }

      if (roundIndex < activeRoundIndex && evaluation.status !== 'complete') {
        throw new Error(
          `Prior knockout series "${series.seriesId}" is incomplete`
        );
      }

      calculatedEvaluations.push(evaluation);
      if (evaluation.status === 'complete') {
        calculatedCompletedEvaluations.push(evaluation);
      }

      return {
        series: rawKnockoutSeries(series),
        games,
        evaluation,
      };
    });

    roundStates.push({
      round: rawKnockoutRound(round),
      seriesStates,
    });

    if (roundIndex > 0) {
      const previousState = roundStates[roundIndex - 1];
      const expectedRound = buildNextKnockoutRound(
        previousState.round,
        previousState.seriesStates.map(state => state.evaluation)
      );

      if (!isDeepStrictEqual(expectedRound, rawKnockoutRound(round))) {
        throw new Error(
          `Knockout execution plan round ${round.round} is not deterministic`
        );
      }
    }
  }

  if (!isDeepStrictEqual(plan.seriesEvaluations, calculatedEvaluations) ||
      !isDeepStrictEqual(
        plan.completedSeriesEvaluations,
        calculatedCompletedEvaluations
      )) {
    throw new Error('Knockout execution plan series evaluations are invalid');
  }

  const activeRoundState = roundStates[activeRoundIndex];
  const expectedRequests = activeRoundState.seriesStates.flatMap(state =>
    state.evaluation.status === 'complete'
      ? []
      : [generateKnockoutSeriesGame(
        state.series,
        state.evaluation.nextGameNumber,
        identity.tournamentSeed
      )]
  );

  if (!isDeepStrictEqual(plan.nextGameRequests, expectedRequests)) {
    throw new Error(
      'Knockout execution plan next game requests are inconsistent'
    );
  }

  const activeRoundAcceptedCount = activeRoundState.seriesStates.reduce(
    (total, state) => total + state.games.length,
    0
  );

  if (!Number.isInteger(plan.acceptedGroupResultCount) ||
      plan.acceptedGroupResultCount < 0 ||
      plan.acceptedGroupResultCount !== plan.validatedGroupRecords.length ||
      plan.acceptedKnockoutResultCount !==
        plan.validatedKnockoutRecords.length ||
      plan.acceptedResultCount !==
        plan.acceptedGroupResultCount + plan.acceptedKnockoutResultCount ||
      plan.schedulePosition !== activeRoundAcceptedCount) {
    throw new Error('Knockout execution plan progress fields are inconsistent');
  }

  const activeRoundComplete = activeRoundState.seriesStates.every(state =>
    state.evaluation.status === 'complete'
  );

  if (activeRoundComplete) {
    if (activeRound.round !== 'r2' || plan.resultComplete !== true ||
        plan.nextGameRequests.length !== 0) {
      throw new Error(
        'Only a result-complete final may have no active knockout work'
      );
    }

    const expectedChampion = selectTournamentChampion(
      activeRoundState.round,
      activeRoundState.seriesStates[0].games,
      identity.tournamentSeed
    );

    if (!isDeepStrictEqual(plan.champion, expectedChampion)) {
      throw new Error('Knockout execution plan champion is inconsistent');
    }
  } else {
    if (plan.resultComplete === true || plan.champion !== null) {
      throw new Error(
        'Incomplete knockout execution plan has final completion fields'
      );
    }

    if (plan.nextGameRequests.length === 0) {
      throw new Error('Knockout execution plan has no schedulable active games');
    }
  }

  return {
    activeRoundComplete,
    activeRoundIndex,
    activeRoundState,
    identity,
    roundStates,
  };
}

function buildKnockoutBracket(
  plan,
  roundStates,
  options
) {
  const rounds = roundStates
    .slice(0, -1)
    .map(enrichKnockoutRound);
  const activeRoundState = roundStates.at(-1);

  if (options.enrichActiveRound) {
    rounds.push(enrichKnockoutRound(activeRoundState));
  } else {
    rounds.push(rawKnockoutRound(activeRoundState.round));
  }

  if (options.nextRound !== undefined) {
    rounds.push(rawKnockoutRound(options.nextRound));
  }

  return {
    schemaVersion: 1,
    runId: plan.metadata.runId,
    status: options.status,
    rounds,
    champion: options.champion,
    updatedAt: options.updatedAt,
  };
}

class KnockoutStorageFailure extends Error {
  constructor(operation, cause) {
    super(`Knockout ${operation} failed: ${cause.message}`, {cause});
    this.name = 'KnockoutStorageFailure';
  }
}

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

  const resultsPath = join(plan.runDirectory, 'results.jsonl');
  const checkpointPath = join(plan.runDirectory, 'checkpoint.json');
  const metadataPath = join(plan.runDirectory, 'run-metadata.json');
  const bracketPath = join(plan.runDirectory, 'bracket.json');
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
    const bracket = buildKnockoutBracket(plan, validation.roundStates, {
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

    await writeJson(bracketPath, bracket);
    await writeJson(checkpointPath, recoveredCheckpoint);

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
  let acceptanceTail = Promise.resolve();

  function recordRequestFailure(request, cause) {
    if (requestFailure === undefined && storageFailure === undefined) {
      requestFailure = {matchId: request.matchId, cause};
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
      await appendResult(resultsPath, response);
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
      await writeJson(checkpointPath, nextCheckpoint);
    } catch (error) {
      throw new KnockoutStorageFailure('checkpoint write', error);
    }

    return nextEvaluation;
  }

  function queueAcceptance(seriesState, request, response) {
    const operation = acceptanceTail.then(() =>
      acceptResponse(seriesState, request, response)
    );

    acceptanceTail = operation.catch(error => {
      if (error instanceof KnockoutStorageFailure) {
        recordStorageFailure(error);
      } else {
        recordRequestFailure(
          request,
          error.cause === undefined ? error : error.cause
        );
      }
    });

    return operation;
  }

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
        response = await runBattle(request);
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
    await acceptanceTail;
  }

  if (storageFailure !== undefined) {
    throw storageFailure;
  }

  if (requestFailure !== undefined) {
    const failedMetadata = {
      ...plan.metadata,
      status: 'failed',
      completedAt: null,
    };
    validateRunMetadata(failedMetadata, validation.identity);
    await writeJson(metadataPath, failedMetadata);

    throw new Error(
      `Knockout execution stopped after battle ` +
        `"${requestFailure.matchId}" failed`,
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
    const nextRound = buildNextKnockoutRound(
      activeRound,
      completedEvaluations
    );
    const bracket = buildKnockoutBracket(plan, validation.roundStates, {
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

    await writeJson(bracketPath, bracket);
    await writeJson(checkpointPath, nextCheckpoint);

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

  const champion = selectTournamentChampion(
    activeRound,
    validation.activeRoundState.seriesStates[0].games,
    plan.metadata.tournamentSeed
  );
  const bracket = buildKnockoutBracket(plan, validation.roundStates, {
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

  await writeJson(bracketPath, bracket);
  await writeJson(checkpointPath, completeCheckpoint);
  await writeJson(metadataPath, completedMetadata);

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

  const reconstruction = reconstructGroupStage(
    runState,
    options.identity,
    options.sampleRoster === undefined
      ? sampleRosterConfiguration
      : options.sampleRoster
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

module.exports = {
  buildGroupStageRecoveryPlan,
  buildGroupStandingsArtifact,
  buildInitialKnockoutArtifact,
  buildKnockoutRecoveryPlan,
  executeGroupStagePlan,
  executeKnockoutPlan,
  planTournamentRun,
};
