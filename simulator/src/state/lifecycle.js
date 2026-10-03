'use strict';

const {mkdir, readdir} = require('node:fs/promises');
const {dirname, join} = require('node:path');
const {requireIsoTimestamp, requireObject, validateRunIdentity, resolveRunDirectory, validateRunMetadata, validateCheckpoint, validateRunRoster} = require('./contracts');
const {METADATA_TEMPORARY_FILE_PATTERN} = require('./constants');
const {atomicWriteJson, readJsonFile} = require('./json-files');
const {readJsonLines, buildCompletedMatchIndex} = require('./result-log');

function currentTimestamp(now) {
  const timestamp = now();
  requireIsoTimestamp(timestamp, 'now() result');
  return timestamp;
}

function isMetadataTemporaryFile(entry) {
  return METADATA_TEMPORARY_FILE_PATTERN.test(entry);
}

async function initializeOrResumeRun(options) {
  requireObject(options, 'Run initialization options');
  validateRunIdentity(options.identity);

  const now = options.now === undefined ?
    () => new Date().toISOString() : options.now;

  if (typeof now !== 'function') {
    throw new TypeError('now must be a function');
  }

  const runDirectory = resolveRunDirectory(
    options.stateRoot,
    options.identity.runId
  );
  await mkdir(dirname(runDirectory), {recursive: true});

  let entries;

  try {
    entries = await readdir(runDirectory);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    await mkdir(runDirectory);
    entries = [];
  }

  const metadataPath = join(runDirectory, 'run-metadata.json');
  const resultsPath = join(runDirectory, 'results.jsonl');
  const checkpointPath = join(runDirectory, 'checkpoint.json');
  const rosterPath = join(runDirectory, 'roster.json');

  const hasOnlyRecoverableMetadataTemporaryFiles =
    entries.every(isMetadataTemporaryFile);

  if (hasOnlyRecoverableMetadataTemporaryFiles) {
    const timestamp = currentTimestamp(now);
    const metadata = {
      schemaVersion: 1,
      runId: options.identity.runId,
      mode: options.identity.mode,
      tournamentSeed: options.identity.tournamentSeed,
      rulesVersion: options.identity.rulesVersion,
      simulatorVersion: options.identity.simulatorVersion,
      simulatorImage: options.identity.simulatorImage,
      runnerConcurrency: options.identity.runnerConcurrency,
      status: 'running',
      startedAt: timestamp,
      completedAt: null,
    };
    const checkpoint = {
      schemaVersion: 1,
      stage: 'groups',
      round: null,
      schedulePosition: 0,
      acceptedResultCount: 0,
      updatedAt: timestamp,
    };

    validateRunMetadata(metadata, options.identity);
    validateCheckpoint(checkpoint);
    await atomicWriteJson(metadataPath, metadata);
    await atomicWriteJson(checkpointPath, checkpoint);

    return {
      runDirectory,
      metadata,
      checkpointHint: checkpoint,
      acceptedRecords: [],
      completedMatches: new Map(),
      roster: undefined,
      resumed: false,
      terminal: false,
    };
  }

  if (!entries.includes('run-metadata.json')) {
    throw new Error(
      `Run directory "${runDirectory}" contains persisted evidence but ` +
        'has no run-metadata.json'
    );
  }

  const metadata = await readJsonFile(metadataPath, 'run metadata JSON');
  validateRunMetadata(metadata, options.identity);

  const roster = await readJsonFile(rosterPath, 'run roster JSON');

  if (roster !== undefined) {
    validateRunRoster(roster, options.identity);
  }

  const rawRecords = await readJsonLines(resultsPath);
  const completedMatches = buildCompletedMatchIndex(rawRecords);
  const acceptedRecords = [...completedMatches.values()];
  const checkpointHint = await readJsonFile(
    checkpointPath,
    'checkpoint JSON'
  );

  if (checkpointHint !== undefined) {
    validateCheckpoint(checkpointHint);
  }

  if (roster === undefined && acceptedRecords.length > 0) {
    throw new Error(
      'Run has accepted results but no immutable roster.json'
    );
  }

  const terminal = metadata.status === 'completed' ||
    metadata.status === 'failed';

  return {
    runDirectory,
    metadata,
    checkpointHint,
    acceptedRecords,
    completedMatches,
    roster,
    resumed: !terminal,
    terminal,
  };
}

module.exports = {
  currentTimestamp,
  isMetadataTemporaryFile,
  initializeOrResumeRun,
};
