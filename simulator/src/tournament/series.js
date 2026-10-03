'use strict';

const {deriveShowdownSeed, deriveTournamentDigest} = require('./seeding');
const {validateKnockoutEntrant} = require('./bracket');

function generateKnockoutSeriesGame(series, gameNumber, tournamentSeed) {
  if (!series || typeof series !== 'object' || Array.isArray(series)) {
    throw new TypeError('Knockout series must be an object');
  }

  if (typeof series.seriesId !== 'string' || series.seriesId === '') {
    throw new TypeError('Knockout series must have a series ID');
  }

  for (const entrantName of ['entrant1', 'entrant2']) {
    const entrant = series[entrantName];

    if (!entrant || typeof entrant !== 'object' || Array.isArray(entrant)) {
      throw new TypeError(`${entrantName} must be an object`);
    }

    if (typeof entrant.species !== 'string' || entrant.species === '') {
      throw new TypeError(`${entrantName} must have a species`);
    }
  }

  if (!Number.isInteger(gameNumber) || gameNumber < 1 || gameNumber > 7) {
    throw new RangeError('Game number must be an integer from 1 through 7');
  }

  if (typeof tournamentSeed !== 'string' || tournamentSeed === '') {
    throw new TypeError('Tournament seed must be a non-empty string');
  }

  const matchId = `${series.seriesId}-game-${String(gameNumber)
    .padStart(2, '0')}`;
  const entrant1Starts = gameNumber % 2 === 1;

  return {
    seriesId: series.seriesId,
    gameNumber,
    matchId,
    pokemon1: entrant1Starts
      ? series.entrant1.species
      : series.entrant2.species,
    pokemon2: entrant1Starts
      ? series.entrant2.species
      : series.entrant1.species,
    seed: deriveShowdownSeed(tournamentSeed, matchId),
  };
}

function evaluateKnockoutSeries(series, acceptedGames, tournamentSeed) {
  if (!Array.isArray(acceptedGames)) {
    throw new TypeError('Accepted knockout games must be an array');
  }

  if (acceptedGames.length > 7) {
    throw new RangeError('A knockout series cannot contain more than 7 games');
  }

  generateKnockoutSeriesGame(series, 1, tournamentSeed);

  let entrant1Wins = 0;
  let entrant2Wins = 0;
  let draws = 0;

  for (const [index, game] of acceptedGames.entries()) {
    const expectedGameNumber = index + 1;

    if (entrant1Wins >= 2 || entrant2Wins >= 2) {
      throw new RangeError(
        `Game ${expectedGameNumber} appears after the series was complete`
      );
    }

    if (!game || typeof game !== 'object' || Array.isArray(game)) {
      throw new TypeError(
        `Accepted game ${expectedGameNumber} must be an object`
      );
    }

    const expected = generateKnockoutSeriesGame(
      series,
      expectedGameNumber,
      tournamentSeed
    );

    for (const field of [
      'seriesId',
      'gameNumber',
      'matchId',
      'pokemon1',
      'pokemon2',
    ]) {
      if (game[field] !== expected[field]) {
        throw new RangeError(
          `Accepted game ${expectedGameNumber} has an inconsistent ${field}`
        );
      }
    }

    if (!Array.isArray(game.seed) || game.seed.length !== 4 ||
        !game.seed.every((value, seedIndex) =>
          value === expected.seed[seedIndex]
        )) {
      throw new RangeError(
        `Accepted game ${expectedGameNumber} has an inconsistent seed`
      );
    }

    if (game.outcome === 'tie') {
      if (game.winnerSide !== null || game.winnerSpecies !== null) {
        throw new RangeError(
          `Tie ${game.matchId} must not have a winner`
        );
      }

      draws++;
      continue;
    }

    if (game.outcome !== 'win') {
      throw new RangeError(
        `Accepted game ${game.matchId} has an unsupported outcome`
      );
    }

    if (game.winnerSide !== 'p1' && game.winnerSide !== 'p2') {
      throw new RangeError(
        `Accepted game ${game.matchId} has an invalid winner side`
      );
    }

    const expectedWinnerSpecies = game.winnerSide === 'p1'
      ? expected.pokemon1
      : expected.pokemon2;
    if (game.winnerSpecies !== expectedWinnerSpecies) {
      throw new RangeError(
        `Accepted game ${game.matchId} has an inconsistent winner`
      );
    }

    const entrant1Won = game.winnerSide === (
      expectedGameNumber % 2 === 1 ? 'p1' : 'p2'
    );
    if (entrant1Won) {
      entrant1Wins++;
    } else {
      entrant2Wins++;
    }
  }

  const gamesPlayed = acceptedGames.length;
  let status = 'in-progress';
  let nextGameNumber = gamesPlayed + 1;
  let winnerSlot = null;
  let resolution = null;
  let lotteryHash = null;

  if (entrant1Wins >= 2 || entrant2Wins >= 2) {
    status = 'complete';
    nextGameNumber = null;
    winnerSlot = entrant1Wins >= 2 ? 'entrant1' : 'entrant2';
    resolution = 'two-wins';
  } else if (gamesPlayed === 7) {
    status = 'complete';
    nextGameNumber = null;

    if (entrant1Wins !== entrant2Wins) {
      winnerSlot = entrant1Wins > entrant2Wins ? 'entrant1' : 'entrant2';
      resolution = 'game-cap-wins';
    } else {
      const lotteryDigest = deriveTournamentDigest(
        tournamentSeed,
        `${series.seriesId}-lottery`
      );
      lotteryHash = lotteryDigest.toString('hex');
      winnerSlot = lotteryDigest[0] & 0x80 ? 'entrant2' : 'entrant1';
      resolution = 'hash-lottery';
    }
  }

  const winner = winnerSlot === null
    ? null
    : {
      slot: winnerSlot,
      group: series[winnerSlot].group,
      rank: series[winnerSlot].rank,
      speciesId: series[winnerSlot].speciesId,
      species: series[winnerSlot].species,
    };

  return {
    seriesId: series.seriesId,
    status,
    gamesPlayed,
    entrant1Wins,
    entrant2Wins,
    draws,
    nextGameNumber,
    winner,
    resolution,
    lotteryHash,
  };
}

function selectTournamentChampion(
  finalRound,
  acceptedGames,
  tournamentSeed
) {
  if (!finalRound || typeof finalRound !== 'object' ||
      Array.isArray(finalRound)) {
    throw new TypeError('Final round must be an object');
  }

  if (finalRound.round !== 'r2') {
    throw new RangeError('Final round must be r2');
  }

  if (!Array.isArray(finalRound.series)) {
    throw new TypeError('Final round series must be an array');
  }

  if (finalRound.series.length !== 1) {
    throw new RangeError('Final round must contain exactly one series');
  }

  const [finalSeries] = finalRound.series;
  if (!finalSeries || typeof finalSeries !== 'object' ||
      Array.isArray(finalSeries)) {
    throw new TypeError('Final series must be an object');
  }

  if (finalSeries.seriesId !== 'r2-series-01') {
    throw new RangeError('Final series must have ID r2-series-01');
  }

  if (finalSeries.position !== 1) {
    throw new RangeError('Final series must occupy position 1');
  }

  const expectedSourceSeriesIds = {
    entrant1: 'r4-series-01',
    entrant2: 'r4-series-02',
  };

  for (const entrantName of ['entrant1', 'entrant2']) {
    const entrant = finalSeries[entrantName];
    validateKnockoutEntrant(entrant, entrantName, finalSeries.seriesId);

    if (typeof entrant.sourceSeriesId !== 'string' ||
        entrant.sourceSeriesId.trim() === '') {
      throw new TypeError(
        `${entrantName} in ${finalSeries.seriesId} must have a source series ID`
      );
    }

    if (entrant.sourceSeriesId !== expectedSourceSeriesIds[entrantName]) {
      throw new RangeError(
        `${entrantName} in ${finalSeries.seriesId} must come from ` +
        expectedSourceSeriesIds[entrantName]
      );
    }
  }

  if (finalSeries.entrant1.speciesId === finalSeries.entrant2.speciesId ||
      finalSeries.entrant1.species === finalSeries.entrant2.species) {
    throw new RangeError('Final series entrants must be distinct species');
  }

  const evaluation = evaluateKnockoutSeries(
    finalSeries,
    acceptedGames,
    tournamentSeed
  );

  if (evaluation.status !== 'complete') {
    throw new RangeError('Final series is incomplete');
  }

  const winnerSlot = evaluation.winner.slot;
  const winner = finalSeries[winnerSlot];

  return {
    finalSeriesId: finalSeries.seriesId,
    winnerSlot,
    champion: {
      group: winner.group,
      rank: winner.rank,
      speciesId: winner.speciesId,
      species: winner.species,
      sourceSeriesId: winner.sourceSeriesId,
    },
    resolution: evaluation.resolution,
    gamesPlayed: evaluation.gamesPlayed,
    entrant1Wins: evaluation.entrant1Wins,
    entrant2Wins: evaluation.entrant2Wins,
    draws: evaluation.draws,
    lotteryHash: evaluation.lotteryHash,
  };
}

module.exports = {
  generateKnockoutSeriesGame,
  evaluateKnockoutSeries,
  selectTournamentChampion,
};
