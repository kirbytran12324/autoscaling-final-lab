'use strict';

const {isDeepStrictEqual} = require('node:util');
const {validateBattleResult} = require('../simulator-client');
const {buildInitialKnockoutRound, buildNextKnockoutRound, evaluateKnockoutSeries, generateKnockoutSeriesGame, selectAdvancers, selectTournamentChampion} = require('../tournament');
const {requireObject, requireTimestamp} = require('./common');

function rawSeries(series) {
  return {
    seriesId: series.seriesId,
    position: series.position,
    entrant1: series.entrant1,
    entrant2: series.entrant2,
  };
}

function rawRound(round) {
  return {
    round: round.round,
    series: round.series.map(rawSeries),
  };
}

function validateBracket(bracket, metadata, standings, resultsById, usedIds) {
  requireObject(bracket, 'bracket.json');
  requireTimestamp(bracket.updatedAt, 'bracket.json updatedAt');

  if (bracket.schemaVersion !== 1 || bracket.runId !== metadata.runId ||
      bracket.status !== 'completed' || !Array.isArray(bracket.rounds) ||
      bracket.rounds.length === 0) {
    throw new Error('bracket.json does not describe a completed tournament');
  }

  const selections = standings.groups.map(group =>
    selectAdvancers(group, standings.advancingCount)
  );
  let expectedRound = buildInitialKnockoutRound(selections);
  const expectedRoundNames = metadata.mode === 'sample'
    ? ['r16', 'r8', 'r4', 'r2']
    : ['r64', 'r32', 'r16', 'r8', 'r4', 'r2'];
  let finalGames;

  if (!isDeepStrictEqual(
    bracket.rounds.map(round => round.round),
    expectedRoundNames
  )) {
    throw new Error('bracket.json has an invalid knockout round progression');
  }

  for (const [roundIndex, storedRound] of bracket.rounds.entries()) {
    requireObject(storedRound, `bracket.json round ${roundIndex + 1}`);

    if (!isDeepStrictEqual(rawRound(storedRound), expectedRound)) {
      throw new Error(
        `bracket.json round ${storedRound.round} conflicts with deterministic entrants`
      );
    }

    const evaluations = [];

    for (const series of storedRound.series) {
      if (!Array.isArray(series.games) || series.games.length === 0) {
        throw new Error(`bracket.json series ${series.seriesId} has no games`);
      }

      const games = series.games.map((game, index) => {
        requireObject(game, `${series.seriesId} game ${index + 1}`);
        const gameNumber = index + 1;
        const expectedRequest = generateKnockoutSeriesGame(
          rawSeries(series),
          gameNumber,
          metadata.tournamentSeed
        );
        const result = resultsById.get(expectedRequest.matchId);

        if (result === undefined) {
          throw new Error(
            `bracket.json references missing result ${expectedRequest.matchId}`
          );
        }

        validateBattleResult(
          expectedRequest,
          result,
          metadata.simulatorVersion
        );

        if (!isDeepStrictEqual(game, {
          ...result,
          gameNumber,
        })) {
          throw new Error(
            `bracket.json game ${expectedRequest.matchId} conflicts with results.jsonl`
          );
        }

        usedIds.add(result.matchId);
        return {...game, seriesId: series.seriesId};
      });
      const evaluation = evaluateKnockoutSeries(
        rawSeries(series),
        games,
        metadata.tournamentSeed
      );

      if (evaluation.status !== 'complete' ||
          !isDeepStrictEqual(series.evaluation, evaluation)) {
        throw new Error(
          `bracket.json series ${series.seriesId} is incomplete or inconsistent`
        );
      }
      evaluations.push(evaluation);
    }

    if (roundIndex < bracket.rounds.length - 1) {
      expectedRound = buildNextKnockoutRound(expectedRound, evaluations);
    } else {
      finalGames = storedRound.series[0].games.map(game => ({
        ...game,
        seriesId: storedRound.series[0].seriesId,
      }));
    }
  }

  const expectedChampion = selectTournamentChampion(
    expectedRound,
    finalGames,
    metadata.tournamentSeed
  );
  if (!isDeepStrictEqual(bracket.champion, expectedChampion)) {
    throw new Error('bracket.json champion conflicts with final series results');
  }

  return {champion: expectedChampion, finalGameCount: finalGames.length};
}

module.exports = {rawSeries, rawRound, validateBracket};
