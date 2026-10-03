'use strict';

const assert = require('node:assert/strict');
const {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const test = require('node:test');
const {
  appendJsonLine,
  atomicWriteJson,
  calculateRosterHash,
  initializeOrResumeRun,
  loadOrCreateRunRoster,
  resolveRunDirectory,
  validateCheckpoint,
  validateRunMetadata,
} = require('../src/runner-state');
const {listBaseSpecies} = require('../src/catalog');
const {deriveShowdownSeed} = require('../src/tournament');
const {
  INITIAL_TIME,
  RESUME_TIME,
  runIdentity,
  runMetadata,
  checkpoint,
  completedResult,
  createStateRoot,
  writeJson,
  initialize,
  persistTestRoster,
  readEvidence
} = require('../test-support/runner-lifecycle');

test('resolveRunDirectory accepts safe DNS-style run IDs', () => {
  for (const runId of [
    'a',
    'run1',
    'sample-run-2026',
    `a${'b'.repeat(61)}z`,
  ]) {
    assert.equal(
      resolveRunDirectory('/state', runId),
      join('/state', 'runs', runId)
    );
  }
});

test('resolveRunDirectory rejects unsafe run IDs', () => {
  for (const runId of [
    '',
    '.',
    '..',
    'UPPER',
    '-leading',
    'trailing-',
    'two--hyphens-',
    'has space',
    'has/slash',
    'has\\slash',
    '/absolute',
    '../escape',
    `a${'b'.repeat(63)}`,
    123,
  ]) {
    assert.throws(
      () => resolveRunDirectory('/state', runId),
      /runId must be a lowercase DNS-style name/i
    );
  }
});

test('run metadata and checkpoint validators accept their contracts', () => {
  const identity = runIdentity();
  const completed = runMetadata(identity, {
    status: 'completed',
    completedAt: RESUME_TIME,
  });
  const knockoutCheckpoint = checkpoint({stage: 'knockout', round: 'r64'});

  assert.strictEqual(validateRunMetadata(completed, identity), completed);
  assert.strictEqual(validateCheckpoint(knockoutCheckpoint), knockoutCheckpoint);
});

test('validators reject invalid identities, timestamps, and progress fields', () => {
  const identity = runIdentity();

  for (const invalidIdentity of [
    runIdentity({mode: 'preview'}),
    runIdentity({tournamentSeed: '  '}),
    runIdentity({rulesVersion: ''}),
    runIdentity({simulatorVersion: null}),
    runIdentity({simulatorImage: ''}),
    runIdentity({runnerConcurrency: 0}),
    runIdentity({runnerConcurrency: 1.5}),
  ]) {
    assert.throws(
      () => validateRunMetadata(runMetadata(invalidIdentity), invalidIdentity)
    );
  }

  for (const invalidMetadata of [
    runMetadata(identity, {schemaVersion: 2}),
    runMetadata(identity, {status: 'paused'}),
    runMetadata(identity, {startedAt: 'not-a-date'}),
    runMetadata(identity, {startedAt: '2026-02-30T00:00:00.000Z'}),
    runMetadata(identity, {completedAt: RESUME_TIME}),
    runMetadata(identity, {status: 'completed', completedAt: null}),
  ]) {
    assert.throws(() => validateRunMetadata(invalidMetadata, identity));
  }

  for (const invalidCheckpoint of [
    checkpoint({schemaVersion: 2}),
    checkpoint({stage: 'waiting'}),
    checkpoint({round: ''}),
    checkpoint({schedulePosition: -1}),
    checkpoint({schedulePosition: 1.5}),
    checkpoint({acceptedResultCount: -1}),
    checkpoint({updatedAt: 'yesterday'}),
  ]) {
    assert.throws(() => validateCheckpoint(invalidCheckpoint));
  }
});
