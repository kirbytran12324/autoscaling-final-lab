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

const INITIAL_TIME = '2026-09-10T01:02:03.000Z';

const RESUME_TIME = '2026-09-10T04:05:06.000Z';

function runIdentity(overrides = {}) {
  return {
    runId: 'sample-2026-09-10',
    mode: 'sample',
    tournamentSeed: 'phase-5-seed',
    rulesVersion: 'rules-v1',
    simulatorVersion: 'pokemon-showdown@0.11.11',
    simulatorImage: 'metronome-simulator:test',
    runnerConcurrency: 4,
    ...overrides,
  };
}

function runMetadata(identity = runIdentity(), overrides = {}) {
  return {
    schemaVersion: 1,
    ...identity,
    status: 'running',
    startedAt: INITIAL_TIME,
    completedAt: null,
    ...overrides,
  };
}

function checkpoint(overrides = {}) {
  return {
    schemaVersion: 1,
    stage: 'groups',
    round: null,
    schedulePosition: 0,
    acceptedResultCount: 0,
    updatedAt: INITIAL_TIME,
    ...overrides,
  };
}

function completedResult(overrides = {}) {
  return {
    matchId: 'group-A-000001',
    pokemon1: 'Snorlax',
    pokemon2: 'Clefable',
    seed: [12345, 23456, 34567, 45678],
    simulatorVersion: 'pokemon-showdown@0.11.11',
    outcome: 'win',
    winnerSide: 'p1',
    winnerSpecies: 'Snorlax',
    turns: 42,
    termination: 'natural',
    protocolHash: 'a'.repeat(64),
    servedBy: 'simulator-1',
    durationMs: 120,
    ...overrides,
  };
}

async function createStateRoot(t) {
  const directory = await mkdtemp(join(tmpdir(), 'runner-lifecycle-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

async function initialize(stateRoot, identity = runIdentity(), now = INITIAL_TIME) {
  return initializeOrResumeRun({
    stateRoot,
    identity,
    now: () => now,
  });
}

async function persistTestRoster(runDirectory, identity = runIdentity()) {
  const roster = {
    schemaVersion: 1,
    runId: identity.runId,
    mode: identity.mode,
    tournamentSeed: identity.tournamentSeed,
    rosterSeed: deriveShowdownSeed(identity.tournamentSeed, 'roster'),
    entrants: listBaseSpecies()
      .slice(0, identity.mode === 'sample' ? 32 : 1025)
      .map((species, index) => ({
        position: index + 1,
        nationalDexNumber: species.num,
        speciesId: species.id,
        species: species.name,
      })),
  };
  roster.rosterHash = calculateRosterHash(roster);
  await atomicWriteJson(join(runDirectory, 'roster.json'), roster);
  return roster;
}

async function readEvidence(runDirectory) {
  const evidence = {};

  for (const entry of (await readdir(runDirectory)).sort()) {
    evidence[entry] = await readFile(join(runDirectory, entry), 'utf8');
  }

  return evidence;
}

module.exports = {
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
};
