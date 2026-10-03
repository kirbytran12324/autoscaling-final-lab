'use strict';

const {createHash} = require('node:crypto');
const {join} = require('node:path');
const {isDeepStrictEqual} = require('node:util');
const {RUN_ID_PATTERN, RUN_STATUSES, RUN_IDENTITY_FIELDS, CHECKPOINT_STAGES, ROSTER_COUNTS} = require('./constants');

function requireObject(value, description) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${description} must be a non-array object`);
  }
}

function requireNonEmptyString(value, description) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${description} must be a non-empty string`);
  }
}

function isValidIsoTimestamp(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
    value
  );

  if (match === null || !Number.isFinite(Date.parse(value))) {
    return false;
  }

  const [, year, month, day, hour, minute, second, offsetHour,
    offsetMinute] = match.map((part, index) => index === 0 ? part :
    (part === undefined ? part : Number(part)));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];

  return daysInMonth !== undefined && day >= 1 && day <= daysInMonth &&
    hour <= 23 && minute <= 59 && second <= 59 &&
    (offsetHour === undefined ||
      (offsetHour <= 23 && offsetMinute <= 59));
}

function requireIsoTimestamp(value, description) {
  if (!isValidIsoTimestamp(value)) {
    throw new TypeError(`${description} must be a valid ISO timestamp`);
  }
}

function validateRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new TypeError(
      'runId must be a lowercase DNS-style name of at most 63 characters'
    );
  }
}

function validateRunIdentity(identity, description = 'Run identity') {
  requireObject(identity, description);
  validateRunId(identity.runId);

  if (identity.mode !== 'sample' && identity.mode !== 'full') {
    throw new TypeError(`${description} mode must be "sample" or "full"`);
  }

  for (const field of [
    'tournamentSeed',
    'rulesVersion',
    'simulatorVersion',
    'simulatorImage',
  ]) {
    requireNonEmptyString(identity[field], `${description} ${field}`);
  }

  if (!Number.isInteger(identity.runnerConcurrency) ||
      identity.runnerConcurrency <= 0) {
    throw new TypeError(
      `${description} runnerConcurrency must be a positive integer`
    );
  }
}

function resolveRunDirectory(stateRoot, runId) {
  requireNonEmptyString(stateRoot, 'stateRoot');
  validateRunId(runId);
  return join(stateRoot, 'runs', runId);
}

function validateRunMetadata(metadata, expectedIdentity) {
  requireObject(metadata, 'Run metadata');
  validateRunIdentity(expectedIdentity, 'Expected run identity');

  if (metadata.schemaVersion !== 1) {
    throw new TypeError('Run metadata schemaVersion must be 1');
  }

  validateRunIdentity(metadata, 'Run metadata');

  if (!RUN_STATUSES.has(metadata.status)) {
    throw new TypeError(
      'Run metadata status must be "running", "completed", or "failed"'
    );
  }

  requireIsoTimestamp(metadata.startedAt, 'Run metadata startedAt');

  if (metadata.status === 'completed') {
    requireIsoTimestamp(metadata.completedAt, 'Run metadata completedAt');
  } else if (metadata.completedAt !== null) {
    throw new TypeError(
      'Run metadata completedAt must be null unless status is "completed"'
    );
  }

  for (const field of RUN_IDENTITY_FIELDS) {
    if (!isDeepStrictEqual(metadata[field], expectedIdentity[field])) {
      throw new Error(
        `Run metadata identity mismatch for immutable field "${field}"`
      );
    }
  }

  return metadata;
}

function validateCheckpoint(checkpoint) {
  requireObject(checkpoint, 'Checkpoint');

  if (checkpoint.schemaVersion !== 1) {
    throw new TypeError('Checkpoint schemaVersion must be 1');
  }

  if (!CHECKPOINT_STAGES.has(checkpoint.stage)) {
    throw new TypeError(
      'Checkpoint stage must be "groups", "knockout", or "complete"'
    );
  }

  if (checkpoint.round !== null &&
      (typeof checkpoint.round !== 'string' ||
        checkpoint.round.trim() === '')) {
    throw new TypeError('Checkpoint round must be null or a non-empty string');
  }

  for (const field of ['schedulePosition', 'acceptedResultCount']) {
    if (!Number.isInteger(checkpoint[field]) || checkpoint[field] < 0) {
      throw new TypeError(
        `Checkpoint ${field} must be a non-negative integer`
      );
    }
  }

  requireIsoTimestamp(checkpoint.updatedAt, 'Checkpoint updatedAt');
  return checkpoint;
}

function rosterHashPayload(roster) {
  return {
    runId: roster.runId,
    mode: roster.mode,
    tournamentSeed: roster.tournamentSeed,
    rosterSeed: roster.rosterSeed,
    entrants: roster.entrants,
  };
}

function calculateRosterHash(roster) {
  return createHash('sha256')
    .update(JSON.stringify(rosterHashPayload(roster)), 'utf8')
    .digest('hex');
}

function validateRunRoster(roster, expectedIdentity) {
  requireObject(roster, 'Run roster');
  validateRunIdentity(expectedIdentity, 'Expected run identity');

  if (roster.schemaVersion !== 1) {
    throw new TypeError('Run roster schemaVersion must be 1');
  }

  for (const field of ['runId', 'mode', 'tournamentSeed']) {
    if (!isDeepStrictEqual(roster[field], expectedIdentity[field])) {
      throw new Error(
        `Run roster identity mismatch for immutable field "${field}"`
      );
    }
  }

  if (!Array.isArray(roster.rosterSeed) || roster.rosterSeed.length !== 4 ||
      roster.rosterSeed.some(value =>
        !Number.isInteger(value) || value < 0 || value > 65535
      )) {
    throw new TypeError(
      'Run roster rosterSeed must contain four integers from 0 through 65535'
    );
  }

  const expectedCount = ROSTER_COUNTS[expectedIdentity.mode];
  if (!Array.isArray(roster.entrants) ||
      roster.entrants.length !== expectedCount) {
    throw new RangeError(
      `Run roster must contain exactly ${expectedCount} entrants`
    );
  }

  const numbers = new Set();
  const ids = new Set();
  const names = new Set();

  for (const [index, entrant] of roster.entrants.entries()) {
    requireObject(entrant, `Run roster entrant ${index + 1}`);

    if (entrant.position !== index + 1) {
      throw new RangeError(
        `Run roster entrant ${index + 1} has an invalid position`
      );
    }

    if (!Number.isInteger(entrant.nationalDexNumber) ||
        entrant.nationalDexNumber < 1 || entrant.nationalDexNumber > 1025) {
      throw new RangeError(
        `Run roster entrant ${index + 1} has an invalid National Dex number`
      );
    }

    requireNonEmptyString(
      entrant.speciesId,
      `Run roster entrant ${index + 1} speciesId`
    );
    requireNonEmptyString(
      entrant.species,
      `Run roster entrant ${index + 1} species`
    );

    if (numbers.has(entrant.nationalDexNumber) || ids.has(entrant.speciesId) ||
        names.has(entrant.species)) {
      throw new RangeError(
        `Run roster contains duplicate entrant "${entrant.species}"`
      );
    }

    numbers.add(entrant.nationalDexNumber);
    ids.add(entrant.speciesId);
    names.add(entrant.species);
  }

  if (typeof roster.rosterHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(roster.rosterHash) ||
      roster.rosterHash !== calculateRosterHash(roster)) {
    throw new Error('Run roster hash does not match its immutable contents');
  }

  return roster;
}

module.exports = {
  requireObject,
  requireNonEmptyString,
  isValidIsoTimestamp,
  requireIsoTimestamp,
  validateRunId,
  validateRunIdentity,
  resolveRunDirectory,
  validateRunMetadata,
  validateCheckpoint,
  rosterHashPayload,
  calculateRosterHash,
  validateRunRoster,
};
