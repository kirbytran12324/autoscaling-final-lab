'use strict';

const {rawKnockoutSeries, rawKnockoutRound} = require('./common');

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

module.exports = {
  enrichKnockoutRound,
  buildKnockoutBracket,
};
