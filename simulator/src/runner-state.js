'use strict';

const {createHash, randomUUID} = require('node:crypto');
const {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} = require('node:fs/promises');
const {basename, dirname, join} = require('node:path');
const {isDeepStrictEqual} = require('node:util');

const DETERMINISTIC_RESULT_FIELDS = Object.freeze([
  'matchId',
  'pokemon1',
  'pokemon2',
  'seed',
  'simulatorVersion',
  'outcome',
  'winnerSide',
  'winnerSpecies',
  'turns',
  'termination',
  'protocolHash',
]);

const RUN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RUN_IDENTITY_FIELDS = Object.freeze([
  'runId',
  'mode',
  'tournamentSeed',
  'rulesVersion',
  'simulatorVersion',
  'simulatorImage',
  'runnerConcurrency',
]);
const RUN_STATUSES = new Set(['running', 'completed', 'failed']);
const CHECKPOINT_STAGES = new Set(['groups', 'knockout', 'complete']);
const ROSTER_COUNTS = Object.freeze({sample: 32, full: 1025});
const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-' +
  '[0-9a-f]{12}';
const METADATA_TEMPORARY_FILE_PATTERN = new RegExp(
  `^\\.run-metadata\\.json\\.[1-9]\\d*\\.${UUID_PATTERN}\\.tmp$`
);

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

function haveSameDeterministicResult(left, right) {
  return DETERMINISTIC_RESULT_FIELDS.every(field =>
    isDeepStrictEqual(left[field], right[field])
  );
}

function buildCompletedMatchIndex(records) {
  if (!Array.isArray(records)) {
    throw new TypeError('Completed match records must be an array');
  }

  const completedMatches = new Map();

  for (const [index, record] of records.entries()) {
    if (record === null || typeof record !== 'object' ||
        Array.isArray(record)) {
      throw new TypeError(
        `Completed match record at index ${index} must be a non-array object`
      );
    }

    for (const field of DETERMINISTIC_RESULT_FIELDS) {
      if (!Object.hasOwn(record, field)) {
        throw new TypeError(
          `Completed match record at index ${index} is missing ` +
            `deterministic field "${field}"`
        );
      }
    }

    if (typeof record.matchId !== 'string' || record.matchId.trim() === '') {
      throw new TypeError(
        `Completed match record at index ${index} must have a non-empty ` +
          'string matchId'
      );
    }

    const previousRecord = completedMatches.get(record.matchId);

    if (previousRecord === undefined) {
      completedMatches.set(record.matchId, record);
    } else if (!haveSameDeterministicResult(previousRecord, record)) {
      throw new Error(
        `Reproducibility conflict for matchId "${record.matchId}": ` +
          'deterministic result fields differ'
      );
    }
  }

  return completedMatches;
}

function serializeJsonLine(value) {
  const serialized = JSON.stringify(value);

  if (serialized === undefined) {
    throw new TypeError('Value cannot be serialized as JSON');
  }

  return `${serialized}\n`;
}

async function atomicWriteJson(filePath, value) {
  const serialized = serializeJsonLine(value);
  const directory = dirname(filePath);
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let temporaryFile;
  let ownsTemporaryFile = false;

  try {
    temporaryFile = await open(temporaryPath, 'wx');
    ownsTemporaryFile = true;
    await temporaryFile.writeFile(serialized, 'utf8');
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;

    await rename(temporaryPath, filePath);
    ownsTemporaryFile = false;
  } catch (error) {
    if (temporaryFile !== undefined) {
      try {
        await temporaryFile.close();
      } catch {
        // Preserve the error that interrupted the durable write.
      }
    }

    if (ownsTemporaryFile) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          error.cleanupError = cleanupError;
        }
      }
    }

    throw error;
  }
}

async function atomicCreateJson(filePath, value) {
  const serialized = serializeJsonLine(value);
  const directory = dirname(filePath);
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let temporaryFile;
  let ownsTemporaryFile = false;

  try {
    temporaryFile = await open(temporaryPath, 'wx');
    ownsTemporaryFile = true;
    await temporaryFile.writeFile(serialized, 'utf8');
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await link(temporaryPath, filePath);
    await unlink(temporaryPath);
    ownsTemporaryFile = false;
  } catch (error) {
    if (temporaryFile !== undefined) {
      try {
        await temporaryFile.close();
      } catch {
        // Preserve the error that interrupted the immutable create.
      }
    }

    if (ownsTemporaryFile) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError;
      }
    }

    throw error;
  }
}

async function loadOrCreateRunRoster(options) {
  requireObject(options, 'Run roster options');
  validateRunIdentity(options.identity);
  requireNonEmptyString(options.runDirectory, 'runDirectory');
  const rosterPath = join(options.runDirectory, 'roster.json');
  let existing = await readJsonFile(rosterPath, 'run roster JSON');

  if (existing !== undefined) {
    validateRunRoster(existing, options.identity);

    if (options.roster !== undefined &&
        !isDeepStrictEqual(existing, options.roster)) {
      throw new Error('Persisted run roster conflicts with the requested roster');
    }

    return {created: false, roster: existing};
  }

  if (options.roster === undefined) {
    return {created: false, roster: undefined};
  }

  validateRunRoster(options.roster, options.identity);

  try {
    await atomicCreateJson(rosterPath, options.roster);
    return {created: true, roster: options.roster};
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  existing = await readJsonFile(rosterPath, 'run roster JSON');
  validateRunRoster(existing, options.identity);

  if (!isDeepStrictEqual(existing, options.roster)) {
    throw new Error('Persisted run roster conflicts with the requested roster');
  }

  return {created: false, roster: existing};
}

async function appendJsonLine(filePath, value) {
  const serialized = serializeJsonLine(value);
  let file;

  try {
    file = await open(filePath, 'a');
    await file.writeFile(serialized, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
  } catch (error) {
    if (file !== undefined) {
      try {
        await file.close();
      } catch {
        // Preserve the error that interrupted the durable append.
      }
    }

    throw error;
  }
}

async function readJsonLines(filePath) {
  let contents;

  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  if (contents.length === 0) {
    return [];
  }

  if (!contents.endsWith('\n')) {
    const lineNumber = contents.split('\n').length;
    throw new Error(
      `JSON Lines record on line ${lineNumber} lacks a terminating newline`
    );
  }

  return contents.slice(0, -1).split('\n').map((line, index) => {
    const lineNumber = index + 1;

    if (line.trim() === '') {
      throw new Error(`Blank JSON Lines record on line ${lineNumber}`);
    }

    try {
      return JSON.parse(line);
    } catch (error) {
      const parseError = new SyntaxError(
        `Malformed JSON on line ${lineNumber}: ${error.message}`
      );
      parseError.cause = error;
      throw parseError;
    }
  });
}

async function readJsonFile(filePath, description) {
  let contents;

  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    const parseError = new SyntaxError(
      `Malformed ${description}: ${error.message}`
    );
    parseError.cause = error;
    throw parseError;
  }
}

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
  appendJsonLine,
  calculateRosterHash,
  atomicWriteJson,
  buildCompletedMatchIndex,
  initializeOrResumeRun,
  loadOrCreateRunRoster,
  readJsonLines,
  resolveRunDirectory,
  validateCheckpoint,
  validateRunMetadata,
  validateRunRoster,
};
