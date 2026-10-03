'use strict';

const {requireObject} = require('./common');

function normalizeFailureError(error) {
  const source = error instanceof Error ? error : new Error(String(error));
  const cause = source.cause instanceof Error ? source.cause : undefined;
  const status = Number.isInteger(source.status)
    ? source.status
    : Number.isInteger(cause && cause.status) ? cause.status : null;
  const code = typeof source.code === 'string' && source.code !== ''
    ? source.code
    : typeof (cause && cause.code) === 'string' && cause.code !== ''
      ? cause.code
      : null;
  const normalized = {
    name: source.name || 'Error',
    code,
    status,
    message: source.message,
  };

  if (cause !== undefined) {
    normalized.cause = {
      name: cause.name || 'Error',
      code: typeof cause.code === 'string' && cause.code !== ''
        ? cause.code
        : null,
      status: Number.isInteger(cause.status) ? cause.status : null,
      message: cause.message,
    };
  }

  return normalized;
}

function buildFailureRecord(identity, request, stage, round, failedAt, cause) {
  requireObject(request, 'Failed battle request');

  if ((stage !== 'groups' && stage !== 'knockout') ||
      (stage === 'groups' && round !== null) ||
      (stage === 'knockout' &&
        (typeof round !== 'string' || round.trim() === ''))) {
    throw new TypeError('Failure stage and round context are invalid');
  }

  if (typeof failedAt !== 'string' || !Number.isFinite(Date.parse(failedAt))) {
    throw new TypeError('Failure timestamp must be a valid ISO timestamp');
  }

  return {
    schemaVersion: 1,
    runId: identity.runId,
    matchId: request.matchId,
    stage,
    round,
    request: structuredClone(request),
    failedAt,
    error: normalizeFailureError(cause),
  };
}

class AcceptanceFailure extends Error {
  constructor(message, cause) {
    super(message, {cause});
    this.name = 'AcceptanceFailure';
  }
}

class StorageFailure extends Error {
  constructor(operation, cause) {
    super(`Group-stage ${operation} failed: ${cause.message}`, {cause});
    this.name = 'StorageFailure';
  }
}

class KnockoutStorageFailure extends Error {
  constructor(operation, cause) {
    super(`Knockout ${operation} failed: ${cause.message}`, {cause});
    this.name = 'KnockoutStorageFailure';
  }
}

// Shared classification keeps storage outages out of failed-tournament metadata.
function createAcceptanceFailureHandler({StorageError, onStorageFailure, onRequestFailure}) {
  return (request, error) => {
    if (error instanceof StorageError) onStorageFailure(error);
    else onRequestFailure(request, error.cause === undefined ? error : error.cause);
  };
}

module.exports = {
  createAcceptanceFailureHandler,
  normalizeFailureError,
  buildFailureRecord,
  AcceptanceFailure,
  StorageFailure,
  KnockoutStorageFailure,
};
