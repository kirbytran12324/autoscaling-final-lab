'use strict';

const {GROUP_NAMES} = require('./constants');

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

module.exports = {
  requireObject,
  isKnockoutMatchId,
  buildScheduleLookup,
  identityFromMetadata,
  expectedGroupResultCount,
  resolveRunBattle,
  rawKnockoutSeries,
  rawKnockoutRound,
};
