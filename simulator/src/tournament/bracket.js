'use strict';

const {GROUP_NAMES, SAMPLE_ADVANCERS_PER_GROUP, FULL_ADVANCERS_PER_GROUP, NEXT_KNOCKOUT_ROUND, KNOCKOUT_SERIES_COUNTS} = require('./rules');

function buildInitialKnockoutRound(groupAdvancers) {
  if (!Array.isArray(groupAdvancers)) {
    throw new TypeError('Group advancers must be an array');
  }

  if (groupAdvancers.length !== GROUP_NAMES.length) {
    throw new RangeError('Group advancers must contain exactly four groups');
  }

  const selectionsByGroup = new Map();

  for (const selection of groupAdvancers) {
    if (!selection || typeof selection !== 'object' ||
        Array.isArray(selection)) {
      throw new TypeError('Every group advancer selection must be an object');
    }

    if (!GROUP_NAMES.includes(selection.group)) {
      throw new RangeError(`Unknown advancing group: ${selection.group}`);
    }

    if (selectionsByGroup.has(selection.group)) {
      throw new RangeError(`Duplicate advancing group: ${selection.group}`);
    }

    selectionsByGroup.set(selection.group, selection);
  }

  const advancementCounts = new Set(
    groupAdvancers.map(selection => selection.advancingCount)
  );
  if (advancementCounts.size !== 1) {
    throw new RangeError('All groups must have the same advancing count');
  }

  const [advancingCount] = advancementCounts;
  if (advancingCount !== SAMPLE_ADVANCERS_PER_GROUP &&
      advancingCount !== FULL_ADVANCERS_PER_GROUP) {
    throw new RangeError(
      'Advancing count must be 4 for sample mode or 16 for full mode'
    );
  }

  const copiedAdvancersByGroup = new Map();
  const speciesIds = new Set();
  const speciesNames = new Set();

  for (const groupName of GROUP_NAMES) {
    const selection = selectionsByGroup.get(groupName);

    if (!selection) {
      throw new RangeError(`Missing advancing group: ${groupName}`);
    }

    if (!Array.isArray(selection.advancers)) {
      throw new TypeError(`Group ${groupName} advancers must be an array`);
    }

    if (selection.advancers.length !== advancingCount) {
      throw new RangeError(
        `Group ${groupName} must contain exactly ${advancingCount} advancers`
      );
    }

    const copiedAdvancers = selection.advancers.map((entrant, index) => {
      const expectedRank = index + 1;

      if (!entrant || typeof entrant !== 'object' ||
          Array.isArray(entrant)) {
        throw new TypeError(
          `Group ${groupName} entrant at rank ${expectedRank} must be an object`
        );
      }

      if (entrant.group !== groupName) {
        throw new RangeError(
          `Group ${groupName} entrant at rank ${expectedRank} has an ` +
          'inconsistent group'
        );
      }

      if (!Number.isInteger(entrant.rank) ||
          entrant.rank !== expectedRank) {
        throw new RangeError(
          `Group ${groupName} entrant at position ${expectedRank} has an ` +
          'invalid rank'
        );
      }

      if (typeof entrant.speciesId !== 'string' ||
          entrant.speciesId === '' ||
          typeof entrant.species !== 'string' || entrant.species === '') {
        throw new TypeError(
          `Group ${groupName} entrant at rank ${expectedRank} has invalid ` +
          'species fields'
        );
      }

      if (speciesIds.has(entrant.speciesId) ||
          speciesNames.has(entrant.species)) {
        throw new RangeError(
          `Duplicate knockout species: ${entrant.species}`
        );
      }
      speciesIds.add(entrant.speciesId);
      speciesNames.add(entrant.species);

      return {
        group: entrant.group,
        rank: entrant.rank,
        speciesId: entrant.speciesId,
        species: entrant.species,
      };
    });

    copiedAdvancersByGroup.set(groupName, copiedAdvancers);
  }

  const round = advancingCount === SAMPLE_ADVANCERS_PER_GROUP
    ? 'r16'
    : 'r64';
  const series = [];
  const groupPairs = [['A', 'B'], ['C', 'D']];

  for (const [firstGroup, secondGroup] of groupPairs) {
    const firstAdvancers = copiedAdvancersByGroup.get(firstGroup);
    const secondAdvancers = copiedAdvancersByGroup.get(secondGroup);

    for (let highRank = 1; highRank <= advancingCount / 2; highRank++) {
      const lowRank = advancingCount + 1 - highRank;
      const pairings = [
        [firstAdvancers[highRank - 1], secondAdvancers[lowRank - 1]],
        [secondAdvancers[highRank - 1], firstAdvancers[lowRank - 1]],
      ];

      for (const [entrant1, entrant2] of pairings) {
        const position = series.length + 1;
        series.push({
          seriesId: `${round}-series-${String(position).padStart(2, '0')}`,
          position,
          entrant1,
          entrant2,
        });
      }
    }
  }

  return {round, series};
}

function validateKnockoutEntrant(entrant, entrantName, seriesId) {
  if (!entrant || typeof entrant !== 'object' || Array.isArray(entrant)) {
    throw new TypeError(
      `${entrantName} in ${seriesId} must be an object`
    );
  }

  if (typeof entrant.group !== 'string' || entrant.group.trim() === '' ||
      typeof entrant.speciesId !== 'string' ||
      entrant.speciesId.trim() === '' ||
      typeof entrant.species !== 'string' ||
      entrant.species.trim() === '') {
    throw new TypeError(
      `${entrantName} in ${seriesId} has invalid identity fields`
    );
  }

  if (!Number.isInteger(entrant.rank) || entrant.rank <= 0) {
    throw new RangeError(
      `${entrantName} in ${seriesId} must have a positive integer rank`
    );
  }
}

function buildNextKnockoutRound(previousRound, seriesEvaluations) {
  if (!previousRound || typeof previousRound !== 'object' ||
      Array.isArray(previousRound)) {
    throw new TypeError('Previous knockout round must be an object');
  }

  if (!Object.hasOwn(NEXT_KNOCKOUT_ROUND, previousRound.round)) {
    throw new RangeError(
      'Previous knockout round must be r64, r32, r16, r8, or r4'
    );
  }
  const nextRound = NEXT_KNOCKOUT_ROUND[previousRound.round];

  if (!Array.isArray(previousRound.series)) {
    throw new TypeError('Previous knockout round series must be an array');
  }

  const expectedSeriesCount = KNOCKOUT_SERIES_COUNTS[previousRound.round];
  if (previousRound.series.length !== expectedSeriesCount) {
    throw new RangeError(
      `Round ${previousRound.round} must contain exactly ` +
      `${expectedSeriesCount} series`
    );
  }

  const previousSeriesById = new Map();

  for (const [index, series] of previousRound.series.entries()) {
    const expectedPosition = index + 1;

    if (!series || typeof series !== 'object' || Array.isArray(series)) {
      throw new TypeError(
        `Previous series at position ${expectedPosition} must be an object`
      );
    }

    if (!Number.isInteger(series.position) ||
        series.position !== expectedPosition) {
      throw new RangeError(
        `Previous series at position ${expectedPosition} has an invalid ` +
        'position'
      );
    }

    const expectedSeriesId = `${previousRound.round}-series-${String(
      expectedPosition
    ).padStart(2, '0')}`;
    if (series.seriesId !== expectedSeriesId) {
      throw new RangeError(
        `Previous series at position ${expectedPosition} has an invalid ` +
        'series ID'
      );
    }

    validateKnockoutEntrant(series.entrant1, 'entrant1', series.seriesId);
    validateKnockoutEntrant(series.entrant2, 'entrant2', series.seriesId);
    previousSeriesById.set(series.seriesId, series);
  }

  if (!Array.isArray(seriesEvaluations)) {
    throw new TypeError('Series evaluations must be an array');
  }

  if (seriesEvaluations.length !== expectedSeriesCount) {
    throw new RangeError(
      `Round ${previousRound.round} must have exactly ` +
      `${expectedSeriesCount} series evaluations`
    );
  }

  const winnerEntrantsBySeriesId = new Map();
  const validResolutions = new Set([
    'two-wins',
    'game-cap-wins',
    'hash-lottery',
  ]);

  for (const evaluation of seriesEvaluations) {
    if (!evaluation || typeof evaluation !== 'object' ||
        Array.isArray(evaluation)) {
      throw new TypeError('Every series evaluation must be an object');
    }

    if (typeof evaluation.seriesId !== 'string' ||
        evaluation.seriesId.trim() === '') {
      throw new TypeError('Every series evaluation must have a series ID');
    }

    if (winnerEntrantsBySeriesId.has(evaluation.seriesId)) {
      throw new RangeError(
        `Duplicate series evaluation: ${evaluation.seriesId}`
      );
    }

    const previousSeries = previousSeriesById.get(evaluation.seriesId);
    if (!previousSeries) {
      throw new RangeError(
        `Unknown series evaluation: ${evaluation.seriesId}`
      );
    }

    if (evaluation.status !== 'complete' ||
        evaluation.nextGameNumber !== null) {
      throw new RangeError(
        `Series evaluation ${evaluation.seriesId} is not complete`
      );
    }

    if (!validResolutions.has(evaluation.resolution)) {
      throw new RangeError(
        `Series evaluation ${evaluation.seriesId} has an invalid resolution`
      );
    }

    const winner = evaluation.winner;
    if (!winner || typeof winner !== 'object' || Array.isArray(winner)) {
      throw new TypeError(
        `Series evaluation ${evaluation.seriesId} must have a winner`
      );
    }

    if (winner.slot !== 'entrant1' && winner.slot !== 'entrant2') {
      throw new RangeError(
        `Series evaluation ${evaluation.seriesId} has an invalid winner slot`
      );
    }

    validateKnockoutEntrant(
      winner,
      'Winner',
      evaluation.seriesId
    );

    const previousEntrant = previousSeries[winner.slot];
    if (winner.group !== previousEntrant.group ||
        winner.rank !== previousEntrant.rank ||
        winner.speciesId !== previousEntrant.speciesId ||
        winner.species !== previousEntrant.species) {
      throw new RangeError(
        `Series evaluation ${evaluation.seriesId} has an inconsistent winner`
      );
    }

    winnerEntrantsBySeriesId.set(evaluation.seriesId, previousEntrant);
  }

  const series = [];

  for (let index = 0; index < previousRound.series.length; index += 2) {
    const firstPreviousSeries = previousRound.series[index];
    const secondPreviousSeries = previousRound.series[index + 1];
    const firstWinner = winnerEntrantsBySeriesId.get(
      firstPreviousSeries.seriesId
    );
    const secondWinner = winnerEntrantsBySeriesId.get(
      secondPreviousSeries.seriesId
    );
    const position = index / 2 + 1;

    series.push({
      seriesId: `${nextRound}-series-${String(position).padStart(2, '0')}`,
      position,
      entrant1: {
        group: firstWinner.group,
        rank: firstWinner.rank,
        speciesId: firstWinner.speciesId,
        species: firstWinner.species,
        sourceSeriesId: firstPreviousSeries.seriesId,
      },
      entrant2: {
        group: secondWinner.group,
        rank: secondWinner.rank,
        speciesId: secondWinner.speciesId,
        species: secondWinner.species,
        sourceSeriesId: secondPreviousSeries.seriesId,
      },
    });
  }

  return {round: nextRound, series};
}

module.exports = {
  buildInitialKnockoutRound,
  validateKnockoutEntrant,
  buildNextKnockoutRound,
};
