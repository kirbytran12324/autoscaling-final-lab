'use strict';

const assert = require('node:assert/strict');
const {
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
  buildGroupStageRecoveryPlan,
  buildGroupStandingsArtifact,
  buildInitialKnockoutArtifact,
  executeGroupStagePlan,
  planTournamentRun,
} = require('../src/runner');
const {
  appendJsonLine: appendStateJsonLine,
  atomicWriteJson: atomicWriteStateJson,
  readJsonLines,
} = require('../src/runner-state');

const INITIAL_TIME = '2026-09-10T01:02:03.000Z';

const COMPLETED_TIME = '2026-09-10T04:05:06.000Z';

function runIdentity(overrides = {}) {
  return {
    runId: 'sample-runner-test',
    mode: 'sample',
    tournamentSeed: 'runner-planning-seed',
    rulesVersion: 'rules-v1',
    simulatorVersion: 'pokemon-showdown@0.11.11',
    simulatorImage: 'metronome-simulator:test',
    runnerConcurrency: 4,
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

function acceptedRecord(match, identity, overrides = {}) {
  return {
    matchId: match.matchId,
    pokemon1: match.pokemon1,
    pokemon2: match.pokemon2,
    seed: [...match.seed],
    simulatorVersion: identity.simulatorVersion,
    outcome: 'tie',
    winnerSide: null,
    winnerSpecies: null,
    turns: 10,
    termination: 'natural',
    protocolHash: 'a'.repeat(64),
    servedBy: 'simulator-test',
    durationMs: 12.5,
    ...overrides,
  };
}

async function createStateRoot(t) {
  const directory = await mkdtemp(join(tmpdir(), 'runner-plan-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

async function writeRecords(runDirectory, records) {
  const contents = records
    .map(record => JSON.stringify(record))
    .join('\n');
  await writeFile(
    join(runDirectory, 'results.jsonl'),
    contents === '' ? '' : `${contents}\n`,
    'utf8'
  );
}

async function readEvidence(runDirectory) {
  const evidence = {};

  for (const fileName of (await readdir(runDirectory)).sort()) {
    evidence[fileName] = await readFile(join(runDirectory, fileName), 'utf8');
  }

  return evidence;
}

async function newPlan(t, identity = runIdentity()) {
  return planTournamentRun({
    stateRoot: await createStateRoot(t),
    identity,
    now: () => INITIAL_TIME,
  });
}

function executionSubset(plan, length, completedIndexes = []) {
  const groupSchedule = plan.groupSchedule.slice(0, length);
  const completedMatchIds = completedIndexes.map(index =>
    groupSchedule[index].matchId
  );
  const completedIds = new Set(completedMatchIds);
  let schedulePosition = 0;

  while (schedulePosition < groupSchedule.length &&
      completedIds.has(groupSchedule[schedulePosition].matchId)) {
    schedulePosition++;
  }

  return {
    ...plan,
    groupSchedule,
    scheduleByMatchId: new Map(groupSchedule.map(match => [
      match.matchId,
      match,
    ])),
    completedMatchIds,
    validatedRecords: completedIndexes.map(index =>
      acceptedRecord(groupSchedule[index], plan.identity)
    ),
    missingGroupMatches: groupSchedule.filter(match =>
      !completedIds.has(match.matchId)
    ),
    acceptedResultCount: completedMatchIds.length,
    schedulePosition,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, reject, resolve};
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }

  throw new Error('Timed out waiting for test condition');
}

module.exports = {
  INITIAL_TIME,
  COMPLETED_TIME,
  runIdentity,
  checkpoint,
  acceptedRecord,
  createStateRoot,
  writeJson,
  writeRecords,
  readEvidence,
  newPlan,
  executionSubset,
  deferred,
  waitFor
};
