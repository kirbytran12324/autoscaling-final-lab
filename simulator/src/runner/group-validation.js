'use strict';

const {isDeepStrictEqual} = require('node:util');
const {validateRunMetadata} = require('../runner-state');
const {validateBattleResult} = require('../simulator-client');
const {requireObject, identityFromMetadata, expectedGroupResultCount} = require('./common');

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

module.exports = {
  validateExecutionPlan,
};
