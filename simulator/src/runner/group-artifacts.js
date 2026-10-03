'use strict';

const {validateBattleResult} = require('../simulator-client');
const {FULL_ADVANCERS_PER_GROUP, SAMPLE_ADVANCERS_PER_GROUP, buildInitialKnockoutRound, calculateGroupStandings, selectAdvancers} = require('../tournament');
const {expectedGroupResultCount, buildScheduleLookup, requireObject} = require('./common');
const {GROUP_NAMES} = require('./constants');

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

module.exports = {
  buildGroupStandingsArtifact,
  buildInitialKnockoutArtifact,
};
