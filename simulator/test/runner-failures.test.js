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

test('terminal HTTP failure drains started successes before failing metadata', async t => {
  const identity = runIdentity({
    runId: 'terminal-http-failure',
    runnerConcurrency: 3,
  });
  const plan = executionSubset(await newPlan(t, identity), 8);
  const requests = new Map();
  const events = [];
  const responseCause = new Error('Simulator returned HTTP 503');
  responseCause.code = 'SIMULATOR_HTTP_ERROR';
  responseCause.status = 503;
  const terminalCause = new Error('client retries exhausted', {
    cause: responseCause,
  });
  terminalCause.code = 'SIMULATOR_RETRIES_EXHAUSTED';

  const execution = executeGroupStagePlan(plan, {
    runBattle(match) {
      const operation = deferred();
      requests.set(match.matchId, {match, operation});
      return operation.promise;
    },
    async appendJsonLine(path, value) {
      assert.match(path, /results\.jsonl$/);
      events.push(`append:${value.matchId}`);
      await appendStateJsonLine(path, value);
    },
    async appendFailureJsonLine(path, value) {
      events.push(`failure:${value.matchId}`);
      await appendStateJsonLine(path, value);
    },
    async atomicWriteJson(path, value) {
      if (path.endsWith('checkpoint.json')) {
        events.push(`checkpoint:${value.acceptedResultCount}`);
      } else {
        events.push(`metadata:${value.status}`);
      }
      await atomicWriteStateJson(path, value);
    },
    now: () => INITIAL_TIME,
  });

  await waitFor(() => requests.size === 3);
  const [failed, ...successful] = plan.missingGroupMatches.slice(0, 3);
  requests.get(failed.matchId).operation.reject(terminalCause);

  for (const match of successful) {
    requests.get(match.matchId).operation.resolve(
      acceptedRecord(match, identity)
    );
  }

  await assert.rejects(execution, error => {
    assert.match(error.message, new RegExp(failed.matchId));
    assert.strictEqual(error.cause, terminalCause);
    return true;
  });

  assert.equal(requests.size, 3);
  assert.deepEqual(
    events.filter(event => event.startsWith('append:')).sort(),
    successful.map(match => `append:${match.matchId}`).sort()
  );
  assert.equal(events.at(-1), 'metadata:failed');
  assert.equal(events.at(-2), `failure:${failed.matchId}`);
  assert.equal(events.filter(event =>
    event.startsWith('checkpoint:')
  ).length, 2);
  const metadata = JSON.parse(await readFile(
    join(plan.runDirectory, 'run-metadata.json'),
    'utf8'
  ));
  assert.equal(metadata.status, 'failed');
  assert.equal(metadata.startedAt, INITIAL_TIME);
  assert.equal(metadata.completedAt, null);

  const failures = await readJsonLines(
    join(plan.runDirectory, 'failures.jsonl')
  );
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0], {
    schemaVersion: 1,
    runId: identity.runId,
    matchId: failed.matchId,
    stage: 'groups',
    round: null,
    request: failed,
    failedAt: INITIAL_TIME,
    error: {
      name: 'Error',
      code: 'SIMULATOR_RETRIES_EXHAUSTED',
      status: 503,
      message: terminalCause.message,
      cause: {
        name: 'Error',
        code: 'SIMULATOR_HTTP_ERROR',
        status: 503,
        message: responseCause.message,
      },
    },
  });
});

test('failure diagnostics never count as accepted tournament results', async t => {
  const identity = runIdentity({runId: 'failure-log-non-authoritative'});
  const initial = await newPlan(t, identity);
  await appendStateJsonLine(join(initial.runDirectory, 'failures.jsonl'), {
    schemaVersion: 1,
    runId: identity.runId,
    matchId: initial.groupSchedule[0].matchId,
    stage: 'groups',
    round: null,
    request: initial.groupSchedule[0],
    failedAt: INITIAL_TIME,
    error: {name: 'Error', code: null, status: 503, message: 'unavailable'},
  });

  const recovered = await planTournamentRun({
    stateRoot: join(initial.runDirectory, '..', '..'),
    identity,
  });

  assert.equal(recovered.acceptedResultCount, 0);
  assert.equal(recovered.completedMatchIds.length, 0);
  assert.equal(recovered.missingGroupMatches.length, 112);
});

test('result append failure leaves progress unchanged', async t => {
  const identity = runIdentity({runId: 'append-failure'});
  const plan = executionSubset(await newPlan(t, identity), 1);
  const snapshot = JSON.stringify(plan);
  const storageError = new Error('disk append failed');
  let writeCalls = 0;

  await assert.rejects(
    executeGroupStagePlan(plan, {
      async runBattle(match) {
        return acceptedRecord(match, identity);
      },
      async appendJsonLine() {
        throw storageError;
      },
      async atomicWriteJson() {
        writeCalls++;
      },
      now: () => INITIAL_TIME,
    }),
    error => error === storageError
  );

  assert.equal(writeCalls, 0);
  assert.equal(JSON.stringify(plan), snapshot);
});

test('checkpoint failure after append recovers from authoritative JSONL', async t => {
  const identity = runIdentity({runId: 'checkpoint-recovery'});
  const initial = await newPlan(t, identity);
  const plan = executionSubset(initial, 1);
  const checkpointError = new Error('checkpoint replacement failed');

  await assert.rejects(
    executeGroupStagePlan(plan, {
      async runBattle(match) {
        return acceptedRecord(match, identity);
      },
      async atomicWriteJson() {
        throw checkpointError;
      },
      now: () => INITIAL_TIME,
    }),
    error => error === checkpointError
  );

  const staleCheckpoint = JSON.parse(await readFile(
    join(plan.runDirectory, 'checkpoint.json'),
    'utf8'
  ));
  assert.equal(staleCheckpoint.schedulePosition, 0);
  assert.equal(staleCheckpoint.acceptedResultCount, 0);

  const recovered = await planTournamentRun({
    stateRoot: join(plan.runDirectory, '..', '..'),
    identity,
  });

  assert.equal(recovered.acceptedResultCount, 1);
  assert.equal(recovered.schedulePosition, 1);
  assert.equal(
    recovered.completedMatchIds[0],
    plan.groupSchedule[0].matchId
  );
});

test('storage failure never attempts a failed metadata transition', async t => {
  const identity = runIdentity({
    runId: 'storage-no-terminal-transition',
    runnerConcurrency: 2,
  });
  const plan = executionSubset(await newPlan(t, identity), 4);
  const storageError = new Error('PVC unavailable');
  const writes = [];

  await assert.rejects(
    executeGroupStagePlan(plan, {
      async runBattle(match) {
        await new Promise(resolve => setImmediate(resolve));
        return acceptedRecord(match, identity);
      },
      async appendJsonLine() {
        throw storageError;
      },
      async atomicWriteJson(path, value) {
        writes.push({path, value});
      },
      now: () => INITIAL_TIME,
    }),
    error => error === storageError
  );

  assert.equal(writes.length, 0);
  const metadata = JSON.parse(await readFile(
    join(plan.runDirectory, 'run-metadata.json'),
    'utf8'
  ));
  assert.equal(metadata.status, 'running');
});

test('plan construction and execution reject mismatched identity', async t => {
  const identity = runIdentity({runId: 'identity-hardening'});
  const plan = await newPlan(t, identity);
  const runState = {
    runDirectory: plan.runDirectory,
    metadata: plan.metadata,
    checkpointHint: plan.checkpointHint,
    acceptedRecords: plan.validatedRecords,
    completedMatches: new Map(),
    roster: JSON.parse(await readFile(
      join(plan.runDirectory, 'roster.json'),
      'utf8'
    )),
    resumed: true,
    terminal: false,
  };

  assert.throws(
    () => buildGroupStageRecoveryPlan(runState, {
      ...identity,
      tournamentSeed: 'different-seed',
    }),
    /identity mismatch.*tournamentSeed/i
  );

  const mismatchedPlan = executionSubset(plan, 1);
  mismatchedPlan.identity = {
    ...mismatchedPlan.identity,
    simulatorVersion: 'pokemon-showdown@9.9.9',
  };

  await assert.rejects(
    executeGroupStagePlan(mismatchedPlan, {
      async runBattle() {
        throw new Error('must not run');
      },
    }),
    /identity mismatch.*simulatorVersion/i
  );
});

test('successful execution does not mutate its supplied plan', async t => {
  const identity = runIdentity({runId: 'execution-input-preservation'});
  const plan = executionSubset(await newPlan(t, identity), 3, [1]);
  const snapshot = JSON.stringify(plan);

  await executeGroupStagePlan(plan, {
    async runBattle(match) {
      return acceptedRecord(match, identity);
    },
    async appendJsonLine() {},
    async atomicWriteJson() {},
    now: () => INITIAL_TIME,
  });

  assert.equal(JSON.stringify(plan), snapshot);
});
