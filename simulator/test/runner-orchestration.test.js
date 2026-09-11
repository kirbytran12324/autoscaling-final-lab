'use strict';

const assert = require('node:assert/strict');
const {mkdtemp, readFile, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const test = require('node:test');

const {
  planTournamentRun,
  runTournament,
} = require('../src/runner');
const {
  appendJsonLine,
  atomicWriteJson,
  readJsonLines,
} = require('../src/runner-state');

const TEST_TIME = '2026-09-10T04:05:06.000Z';

function runIdentity(overrides = {}) {
  return {
    runId: 'sample-orchestration-test',
    mode: 'sample',
    tournamentSeed: 'orchestration-seed',
    rulesVersion: 'rules-v1',
    simulatorVersion: 'pokemon-showdown@0.11.11',
    simulatorImage: 'metronome-simulator:test',
    runnerConcurrency: 4,
    ...overrides,
  };
}

async function createStateRoot(t) {
  const directory = await mkdtemp(join(tmpdir(), 'runner-orchestration-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

function responseForRequest(request, identity) {
  return {
    matchId: request.matchId,
    pokemon1: request.pokemon1,
    pokemon2: request.pokemon2,
    seed: [...request.seed],
    simulatorVersion: identity.simulatorVersion,
    outcome: 'win',
    winnerSide: 'p1',
    winnerSpecies: request.pokemon1,
    turns: 1,
    termination: 'natural',
    protocolHash: 'a'.repeat(64),
    servedBy: 'deterministic-fake',
    durationMs: 0,
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

test('runTournament drives a new 32-entrant tournament to persisted completion',
  async t => {
    const stateRoot = await createStateRoot(t);
    const identity = runIdentity();
    const requestedMatchIds = [];

    const summary = await runTournament({
      stateRoot,
      identity,
      async runBattle(request) {
        requestedMatchIds.push(request.matchId);
        return responseForRequest(request, identity);
      },
      now: () => TEST_TIME,
    });

    assert.equal(summary.terminal, true);
    assert.equal(summary.stage, 'complete');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.tournamentComplete, true);
    assert.equal(summary.metadata.status, 'completed');

    const [metadata, standings, bracket, records] = await Promise.all([
      readJson(join(summary.runDirectory, 'run-metadata.json')),
      readJson(join(summary.runDirectory, 'standings.json')),
      readJson(join(summary.runDirectory, 'bracket.json')),
      readJsonLines(join(summary.runDirectory, 'results.jsonl')),
    ]);

    assert.equal(metadata.status, 'completed');
    assert.equal(standings.status, 'final');
    assert.equal(standings.expectedResultCount, 112);
    assert.equal(standings.acceptedResultCount, 112);
    assert.equal(standings.groups.length, 4);
    assert.ok(standings.groups.every(group => group.status === 'final'));
    assert.deepEqual(
      bracket.rounds.map(round => round.round),
      ['r16', 'r8', 'r4', 'r2']
    );
    assert.equal(
      bracket.rounds.reduce((total, round) => total + round.series.length, 0),
      15
    );
    assert.equal(bracket.status, 'completed');
    assert.ok(bracket.champion);
    assert.equal(records.length, 157);
    assert.equal(new Set(records.map(record => record.matchId)).size, 157);
    assert.equal(new Set(requestedMatchIds).size, requestedMatchIds.length);
    assert.deepEqual(
      records.map(record => record.matchId).sort(),
      [...requestedMatchIds].sort()
    );
  });

test('runTournament replans until completed metadata is persisted', async t => {
  const stateRoot = await createStateRoot(t);
  const identity = runIdentity({runId: 'metadata-terminal-orchestration'});
  let completedMetadataWrites = 0;
  let battleRequestCount = 0;

  const summary = await runTournament({
    stateRoot,
    identity,
    async runBattle(request) {
      battleRequestCount++;
      return responseForRequest(request, identity);
    },
    async atomicWriteJson(path, value) {
      if (path.endsWith('run-metadata.json') &&
          value.status === 'completed') {
        completedMetadataWrites++;

        if (completedMetadataWrites === 1) return;
      }

      await atomicWriteJson(path, value);
    },
    now: () => TEST_TIME,
  });

  assert.equal(summary.status, 'completed');
  assert.equal(completedMetadataWrites, 2);
  assert.equal(battleRequestCount, 157);
  assert.equal(
    (await readJson(join(summary.runDirectory, 'run-metadata.json'))).status,
    'completed'
  );
});

test('runTournament sends no battles for terminal completed metadata', async t => {
  const stateRoot = await createStateRoot(t);
  const identity = runIdentity({runId: 'already-completed-orchestration'});
  const initial = await planTournamentRun({
    stateRoot,
    identity,
    now: () => TEST_TIME,
  });
  await atomicWriteJson(join(initial.runDirectory, 'run-metadata.json'), {
    ...initial.metadata,
    status: 'completed',
    completedAt: TEST_TIME,
  });
  let battleRequestCount = 0;

  const summary = await runTournament({
    stateRoot,
    identity,
    async runBattle() {
      battleRequestCount++;
      throw new Error('terminal history must not execute battles');
    },
  });

  assert.equal(summary.status, 'completed');
  assert.equal(summary.tournamentComplete, true);
  assert.equal(battleRequestCount, 0);
});

test('runTournament propagates executor and planner failures', async t => {
  await t.test('executor failure', async t => {
    const stateRoot = await createStateRoot(t);
    const identity = runIdentity({runId: 'executor-failure-orchestration'});
    const failure = new Error('deterministic fake failure');

    await assert.rejects(runTournament({
      stateRoot,
      identity,
      async runBattle() {
        throw failure;
      },
      now: () => TEST_TIME,
    }), error => {
      assert.match(error.message, /group-stage execution stopped/i);
      assert.strictEqual(error.cause, failure);
      return true;
    });

    const metadata = await readJson(join(
      stateRoot,
      'runs',
      identity.runId,
      'run-metadata.json'
    ));
    assert.equal(metadata.status, 'failed');
  });

  await t.test('planner failure', async t => {
    const stateRoot = await createStateRoot(t);
    const identity = runIdentity({runId: 'planner-failure-orchestration'});
    const initial = await planTournamentRun({
      stateRoot,
      identity,
      now: () => TEST_TIME,
    });
    await appendJsonLine(
      join(initial.runDirectory, 'results.jsonl'),
      {
        ...responseForRequest(initial.groupSchedule[0], identity),
        matchId: 'unknown-persisted-match',
      }
    );

    await assert.rejects(
      runTournament({stateRoot, identity}),
      /unknown persisted matchId "unknown-persisted-match"/i
    );
  });
});
