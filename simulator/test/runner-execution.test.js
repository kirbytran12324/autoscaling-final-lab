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
const {
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
} = require('../test-support/runner');

test('execution bounds concurrency and sends each missing match once', async t => {
  const identity = runIdentity({
    runId: 'bounded-execution',
    runnerConcurrency: 3,
  });
  const plan = executionSubset(await newPlan(t, identity), 12, [0, 4]);
  const calls = [];
  let activeRequests = 0;
  let maximumActiveRequests = 0;

  const summary = await executeGroupStagePlan(plan, {
    async runBattle(match) {
      calls.push(match);
      activeRequests++;
      maximumActiveRequests = Math.max(
        maximumActiveRequests,
        activeRequests
      );
      await new Promise(resolve => setImmediate(resolve));
      activeRequests--;
      return acceptedRecord(match, identity);
    },
    async appendJsonLine() {},
    async atomicWriteJson() {},
    now: () => INITIAL_TIME,
  });

  assert.equal(maximumActiveRequests, 3);
  assert.equal(calls.length, plan.missingGroupMatches.length);
  assert.deepEqual(calls, plan.missingGroupMatches);
  assert.equal(new Set(calls.map(match => match.matchId)).size, calls.length);
  assert.ok(calls.every(match =>
    !plan.completedMatchIds.includes(match.matchId)
  ));
  assert.deepEqual(summary, {
    stage: 'groups',
    requestedMatchCount: 10,
    acceptedMatchCount: 10,
    acceptedResultCount: 12,
    schedulePosition: 12,
  });
});

test('reverse HTTP completion persists exact responses in completion order', async t => {
  const identity = runIdentity({
    runId: 'reverse-completion',
    runnerConcurrency: 4,
  });
  const plan = executionSubset(await newPlan(t, identity), 4);
  const requests = new Map();

  const execution = executeGroupStagePlan(plan, {
    runBattle(match) {
      const operation = deferred();
      requests.set(match.matchId, {match, operation});
      return operation.promise;
    },
    now: () => INITIAL_TIME,
  });

  await waitFor(() => requests.size === 4);

  for (const match of [...plan.missingGroupMatches].reverse()) {
    const {operation} = requests.get(match.matchId);
    operation.resolve(acceptedRecord(match, identity));
    await new Promise(resolve => setImmediate(resolve));
  }

  const summary = await execution;
  const records = await readJsonLines(join(plan.runDirectory, 'results.jsonl'));
  const persistedCheckpoint = JSON.parse(await readFile(
    join(plan.runDirectory, 'checkpoint.json'),
    'utf8'
  ));

  assert.deepEqual(
    records.map(record => record.matchId),
    [...plan.missingGroupMatches].reverse().map(match => match.matchId)
  );
  assert.deepEqual(
    records,
    [...plan.missingGroupMatches].reverse().map(match =>
      acceptedRecord(match, identity)
    )
  );
  assert.ok(records.every(record => !Object.hasOwn(record, 'group')));
  assert.equal(persistedCheckpoint.schedulePosition, 4);
  assert.equal(persistedCheckpoint.acceptedResultCount, 4);
  assert.equal(summary.schedulePosition, 4);
});

test('acceptance persistence is serialized and appends before checkpoints', async t => {
  const identity = runIdentity({
    runId: 'serialized-persistence',
    runnerConcurrency: 4,
  });
  const plan = executionSubset(await newPlan(t, identity), 6);
  const events = [];
  let activePersistence = 0;
  let maximumActivePersistence = 0;

  async function persist(kind, path, value) {
    activePersistence++;
    maximumActivePersistence = Math.max(
      maximumActivePersistence,
      activePersistence
    );
    events.push(`${kind}:start:${value.matchId || value.acceptedResultCount}`);
    await new Promise(resolve => setImmediate(resolve));
    events.push(`${kind}:end:${value.matchId || value.acceptedResultCount}`);
    activePersistence--;
    assert.ok(path.startsWith(plan.runDirectory));
  }

  await executeGroupStagePlan(plan, {
    async runBattle(match) {
      await new Promise(resolve => setImmediate(resolve));
      return acceptedRecord(match, identity);
    },
    appendJsonLine: (path, value) => persist('append', path, value),
    atomicWriteJson: (path, value) => persist('checkpoint', path, value),
    now: () => INITIAL_TIME,
  });

  assert.equal(maximumActivePersistence, 1);
  assert.equal(events.length, 24);

  for (let index = 0; index < events.length; index += 4) {
    assert.match(events[index], /^append:start:/);
    assert.match(events[index + 1], /^append:end:/);
    assert.match(events[index + 2], /^checkpoint:start:/);
    assert.match(events[index + 3], /^checkpoint:end:/);
  }
});

test('checkpoint position advances only after a contiguous prefix exists', async t => {
  const identity = runIdentity({
    runId: 'contiguous-execution',
    runnerConcurrency: 4,
  });
  const plan = executionSubset(await newPlan(t, identity), 5, [1]);
  const requests = new Map();
  const checkpoints = [];

  const execution = executeGroupStagePlan(plan, {
    runBattle(match) {
      const operation = deferred();
      requests.set(match.matchId, operation);
      return operation.promise;
    },
    async appendJsonLine() {},
    async atomicWriteJson(path, value) {
      assert.match(path, /checkpoint\.json$/);
      checkpoints.push(structuredClone(value));
    },
    now: () => INITIAL_TIME,
  });

  await waitFor(() => requests.size === 4);

  for (const index of [2, 3, 4]) {
    const match = plan.groupSchedule[index];
    requests.get(match.matchId).resolve(acceptedRecord(match, identity));
  }

  await waitFor(() => checkpoints.length === 3);
  assert.ok(checkpoints.every(value => value.schedulePosition === 0));

  const firstMatch = plan.groupSchedule[0];
  requests.get(firstMatch.matchId).resolve(acceptedRecord(
    firstMatch,
    identity
  ));

  const summary = await execution;

  assert.equal(checkpoints.at(-1).schedulePosition, 5);
  assert.equal(checkpoints.at(-1).acceptedResultCount, 5);
  assert.equal(summary.schedulePosition, 5);
});

test('a non-final no-work plan performs no execution operations', async t => {
  const identity = runIdentity({runId: 'nothing-missing'});
  const plan = executionSubset(await newPlan(t, identity), 4, [0, 1, 2, 3]);
  const snapshot = JSON.stringify(plan);

  const summary = await executeGroupStagePlan(plan);

  assert.deepEqual(summary, {
    stage: 'groups',
    requestedMatchCount: 0,
    acceptedMatchCount: 0,
    acceptedResultCount: 4,
    schedulePosition: 4,
  });
  assert.equal(JSON.stringify(plan), snapshot);
});

test('injected client responses are independently validated', async t => {
  const identity = runIdentity({runId: 'invalid-fake-response'});
  const plan = executionSubset(await newPlan(t, identity), 1);
  const writes = [];
  let appendCalls = 0;

  await assert.rejects(
    executeGroupStagePlan(plan, {
      simulatorClient: {
        async runBattle(match) {
          return acceptedRecord(match, identity, {pokemon1: 'Pikachu'});
        },
      },
      async appendJsonLine() {
        appendCalls++;
      },
      async atomicWriteJson(path, value) {
        writes.push({path, value});
      },
      now: () => INITIAL_TIME,
    }),
    error => {
      assert.match(error.message, /invalid-fake-response|failed/i);
      assert.match(error.cause.message, /pokemon1.*match the request/i);
      return true;
    }
  );

  assert.equal(appendCalls, 0);
  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /run-metadata\.json$/);
  assert.equal(writes[0].value.status, 'failed');
});
