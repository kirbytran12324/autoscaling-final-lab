'use strict';

function buildMatchContext(artifacts) {
  const context = new Map();

  for (const [matchId, group] of artifacts.groupByMatchId) {
    context.set(matchId, {stage: 'Group stage', group});
  }
  for (const round of artifacts.bracket.rounds) {
    for (const series of round.series) {
      for (const game of series.games) {
        context.set(game.matchId, {
          stage: 'Knockout',
          round: round.round,
          seriesId: series.seriesId,
          gameNumber: game.gameNumber,
        });
      }
    }
  }
  return context;
}

function enrichMatch(match, context) {
  return {...match, ...(context.get(match.matchId) || {stage: 'Unknown'})};
}
module.exports = {buildMatchContext, enrichMatch};
