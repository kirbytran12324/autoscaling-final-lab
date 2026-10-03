'use strict';

const {validateBattleResult} = require('../simulator-client');
const {KNOCKOUT_SERIES_COUNTS, NEXT_KNOCKOUT_ROUND, buildNextKnockoutRound, evaluateKnockoutSeries, generateKnockoutSeriesGame, selectTournamentChampion} = require('../tournament');
const {KNOCKOUT_MATCH_ID_PATTERN} = require('./constants');
const {expectedGroupResultCount} = require('./common');
const {buildGroupStandingsArtifact, buildInitialKnockoutArtifact} = require('./group-artifacts');
const {reconstructGroupStage} = require('./group-recovery');

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
  identity
) {
  return buildKnockoutPlanFromReconstruction(
    reconstructGroupStage(runState, identity),
    identity
  );
}

module.exports = {
  parseKnockoutRecord,
  validatePersistedKnockoutGame,
  buildKnockoutPlanFromReconstruction,
  buildKnockoutRecoveryPlan,
};
