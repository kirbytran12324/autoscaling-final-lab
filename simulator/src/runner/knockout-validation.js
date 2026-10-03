'use strict';

const {isDeepStrictEqual} = require('node:util');
const {validateRunMetadata} = require('../runner-state');
const {validateBattleResult} = require('../simulator-client');
const {buildNextKnockoutRound, evaluateKnockoutSeries, generateKnockoutSeriesGame, selectTournamentChampion} = require('../tournament');
const {requireObject, identityFromMetadata, rawKnockoutSeries, rawKnockoutRound} = require('./common');
const {KNOCKOUT_MATCH_ID_PATTERN} = require('./constants');

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

module.exports = {
  validateKnockoutExecutionPlan,
};
