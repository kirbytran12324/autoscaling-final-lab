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

const configuredSampleRoster = require('../config/sample_roster.json');
const {
  buildGroupStageRecoveryPlan,
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

test('a new sample run plans all 112 group matches as missing', async t => {
  const plan = await newPlan(t);

  assert.equal(plan.terminal, false);
  assert.equal(plan.stage, 'groups');
  assert.equal(plan.roster.length, 32);
  assert.equal(plan.groupSchedule.length, 112);
  assert.equal(plan.scheduleByMatchId.size, 112);
  assert.equal(plan.completedMatchIds.length, 0);
  assert.deepEqual(plan.missingGroupMatches, plan.groupSchedule);
  assert.equal(plan.acceptedResultCount, 0);
  assert.equal(plan.schedulePosition, 0);
});

test('full mode builds the complete deterministic group schedule', async t => {
  const identity = runIdentity({
    runId: 'full-runner-test',
    mode: 'full',
  });
  const plan = await newPlan(t, identity);

  assert.equal(plan.roster.length, 1025);
  assert.deepEqual(
    Object.values(plan.groups).map(group => group.length),
    [257, 256, 256, 256]
  );
  assert.equal(plan.groupSchedule.length, 130816);
  assert.equal(plan.scheduleByMatchId.size, 130816);
  assert.strictEqual(
    plan.scheduleByMatchId.get(plan.groupSchedule[0].matchId),
    plan.groupSchedule[0]
  );
});

test('contiguous persisted completion advances the prefix position', async t => {
  const identity = runIdentity();
  const initial = await newPlan(t, identity);
  const records = initial.groupSchedule
    .slice(0, 4)
    .map(match => acceptedRecord(match, identity));
  await writeRecords(initial.runDirectory, records);

  const plan = await planTournamentRun({
    stateRoot: join(initial.runDirectory, '..', '..'),
    identity,
  });

  assert.deepEqual(
    plan.completedMatchIds,
    initial.groupSchedule.slice(0, 4).map(match => match.matchId)
  );
  assert.deepEqual(plan.missingGroupMatches, initial.groupSchedule.slice(4));
  assert.equal(plan.acceptedResultCount, 4);
  assert.equal(plan.schedulePosition, 4);
});

test('out-of-order completion stays complete without skipping a hole', async t => {
  const identity = runIdentity();
  const initial = await newPlan(t, identity);
  const completedIndexes = [0, 2, 7];
  await writeRecords(
    initial.runDirectory,
    completedIndexes.map(index =>
      acceptedRecord(initial.groupSchedule[index], identity)
    ).reverse()
  );

  const plan = await planTournamentRun({
    stateRoot: join(initial.runDirectory, '..', '..'),
    identity,
  });

  assert.deepEqual(
    plan.completedMatchIds,
    completedIndexes.map(index => initial.groupSchedule[index].matchId)
  );
  assert.equal(plan.schedulePosition, 1);
  assert.equal(
    plan.missingGroupMatches[0].matchId,
    initial.groupSchedule[1].matchId
  );
  assert.ok(!plan.missingGroupMatches.some(match =>
    plan.completedMatchIds.includes(match.matchId)
  ));
});

test('a stale checkpoint is reconciled in memory and is not rewritten', async t => {
  const identity = runIdentity();
  const initial = await newPlan(t, identity);
  const records = initial.groupSchedule.slice(0, 2).map(match =>
    acceptedRecord(match, identity)
  );
  const staleCheckpoint = checkpoint({
    schedulePosition: 99,
    acceptedResultCount: 87,
  });
  await writeRecords(initial.runDirectory, records);
  await writeJson(
    join(initial.runDirectory, 'checkpoint.json'),
    staleCheckpoint
  );
  const before = await readEvidence(initial.runDirectory);

  const plan = await planTournamentRun({
    stateRoot: join(initial.runDirectory, '..', '..'),
    identity,
  });

  assert.deepEqual(plan.checkpointHint, staleCheckpoint);
  assert.equal(plan.acceptedResultCount, 2);
  assert.equal(plan.schedulePosition, 2);
  assert.deepEqual(await readEvidence(initial.runDirectory), before);
});

test('an unknown persisted match ID is rejected', async t => {
  const identity = runIdentity();
  const initial = await newPlan(t, identity);
  await writeRecords(initial.runDirectory, [acceptedRecord(
    initial.groupSchedule[0],
    identity,
    {matchId: 'group-Z-999999'}
  )]);

  await assert.rejects(
    planTournamentRun({
      stateRoot: join(initial.runDirectory, '..', '..'),
      identity,
    }),
    /unknown persisted matchId.*group-Z-999999/i
  );
});

test('persisted request, version, and result conflicts are rejected', async t => {
  const cases = [
    ['participants', {pokemon2: 'Pikachu'}, /pokemon2.*match the request/i],
    ['seed', {seed: [1, 2, 3, 4]}, /seed.*matching the request/i],
    [
      'simulator version',
      {simulatorVersion: 'pokemon-showdown@9.9.9'},
      /simulatorVersion.*pinned version/i,
    ],
    [
      'result contract',
      {winnerSide: 'p1'},
      /tie.*null winnerSide and winnerSpecies/i,
    ],
  ];

  for (const [name, overrides, pattern] of cases) {
    await t.test(name, async t => {
      const identity = runIdentity({
        runId: `conflict-${name.replace(' ', '-')}`,
      });
      const initial = await newPlan(t, identity);
      await writeRecords(initial.runDirectory, [acceptedRecord(
        initial.groupSchedule[0],
        identity,
        overrides
      )]);

      await assert.rejects(
        planTournamentRun({
          stateRoot: join(initial.runDirectory, '..', '..'),
          identity,
        }),
        pattern
      );
    });
  }
});

test('a fully completed group schedule has no missing work', async t => {
  const identity = runIdentity();
  const initial = await newPlan(t, identity);
  await writeRecords(
    initial.runDirectory,
    initial.groupSchedule.map(match => acceptedRecord(match, identity))
  );

  const plan = await planTournamentRun({
    stateRoot: join(initial.runDirectory, '..', '..'),
    identity,
  });

  assert.equal(plan.acceptedResultCount, 112);
  assert.equal(plan.schedulePosition, 112);
  assert.deepEqual(
    plan.completedMatchIds,
    initial.groupSchedule.map(match => match.matchId)
  );
  assert.deepEqual(plan.missingGroupMatches, []);
});

test('completed and failed runs stop as terminal read-only history', async t => {
  for (const status of ['completed', 'failed']) {
    await t.test(status, async t => {
      const identity = runIdentity({runId: `terminal-${status}`});
      const initial = await newPlan(t, identity);
      await writeJson(join(initial.runDirectory, 'run-metadata.json'), {
        ...initial.metadata,
        status,
        completedAt: status === 'completed' ? COMPLETED_TIME : null,
      });
      await writeRecords(initial.runDirectory, [acceptedRecord(
        initial.groupSchedule[0],
        identity,
        {matchId: 'not-in-the-group-schedule'}
      )]);
      const before = await readEvidence(initial.runDirectory);

      const result = await planTournamentRun({
        stateRoot: join(initial.runDirectory, '..', '..'),
        identity,
      });

      assert.equal(result.terminal, true);
      assert.equal(result.status, status);
      assert.equal(Object.hasOwn(result, 'groupSchedule'), false);
      assert.deepEqual(await readEvidence(initial.runDirectory), before);
    });
  }
});

test('planning is deterministic, schedule ordered, and input preserving', async t => {
  const identity = runIdentity();
  const initial = await newPlan(t, identity);
  const acceptedRecords = [
    acceptedRecord(initial.groupSchedule[4], identity),
    acceptedRecord(initial.groupSchedule[0], identity),
  ];
  const runState = {
    runDirectory: '/state/runs/sample-runner-test',
    metadata: structuredClone(initial.metadata),
    checkpointHint: checkpoint({
      schedulePosition: 88,
      acceptedResultCount: 44,
    }),
    acceptedRecords,
    completedMatches: new Map(acceptedRecords.map(record => [
      record.matchId,
      record,
    ])),
    resumed: true,
    terminal: false,
  };
  const stateSnapshot = structuredClone(runState);
  const identitySnapshot = structuredClone(identity);
  const roster = [...configuredSampleRoster];
  const rosterSnapshot = [...roster];

  const first = buildGroupStageRecoveryPlan(runState, identity, roster);
  const second = buildGroupStageRecoveryPlan(runState, identity, roster);

  assert.deepEqual(first.groupSchedule, second.groupSchedule);
  assert.deepEqual(first.rosterSeed, second.rosterSeed);
  assert.deepEqual(first.completedMatchIds, [
    initial.groupSchedule[0].matchId,
    initial.groupSchedule[4].matchId,
  ]);
  assert.deepEqual(
    first.missingGroupMatches.map(match => match.matchId),
    initial.groupSchedule
      .filter((_, index) => index !== 0 && index !== 4)
      .map(match => match.matchId)
  );
  assert.strictEqual(
    first.scheduleByMatchId.get(initial.groupSchedule[10].matchId),
    first.groupSchedule[10]
  );
  assert.deepEqual(runState, stateSnapshot);
  assert.deepEqual(identity, identitySnapshot);
  assert.deepEqual(roster, rosterSnapshot);
});

test('knockout recovery is rejected explicitly', async t => {
  const identity = runIdentity();
  const initial = await newPlan(t, identity);
  await writeJson(join(initial.runDirectory, 'checkpoint.json'), checkpoint({
    stage: 'knockout',
    round: 'r64',
  }));

  await assert.rejects(
    planTournamentRun({
      stateRoot: join(initial.runDirectory, '..', '..'),
      identity,
    }),
    /unsupported knockout recovery.*only plans the group stage/i
  );

  await writeJson(
    join(initial.runDirectory, 'checkpoint.json'),
    checkpoint()
  );
  await writeRecords(initial.runDirectory, [acceptedRecord(
    initial.groupSchedule[0],
    identity,
    {matchId: 'r64-series-01-game-01'}
  )]);

  await assert.rejects(
    planTournamentRun({
      stateRoot: join(initial.runDirectory, '..', '..'),
      identity,
    }),
    /unsupported knockout recovery.*r64-series-01-game-01/i
  );
});

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

test('a fully recovered plan performs no execution operations', async t => {
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

test('terminal HTTP failure drains started successes before failing metadata', async t => {
  const identity = runIdentity({
    runId: 'terminal-http-failure',
    runnerConcurrency: 3,
  });
  const plan = executionSubset(await newPlan(t, identity), 8);
  const requests = new Map();
  const events = [];
  const terminalCause = new Error('client retries exhausted');

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
