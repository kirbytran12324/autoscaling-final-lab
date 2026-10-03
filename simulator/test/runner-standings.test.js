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

test('provisional standings use absolute sample and full cadences', async t => {
  const cases = [
    {
      mode: 'sample',
      cadence: 10,
      recoveredCount: 7,
      scheduleLength: 11,
    },
    {
      mode: 'full',
      cadence: 1000,
      recoveredCount: 997,
      scheduleLength: 1001,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.mode, async t => {
      const identity = runIdentity({
        runId: `${testCase.mode}-cadence`,
        mode: testCase.mode,
        runnerConcurrency: 2,
      });
      const basePlan = await newPlan(t, identity);
      const recoveredIndexes = Array.from(
        {length: testCase.recoveredCount},
        (_, index) => index
      );
      const plan = executionSubset(
        basePlan,
        testCase.scheduleLength,
        recoveredIndexes
      );
      const standingsWrites = [];

      await executeGroupStagePlan(plan, {
        async runBattle(match) {
          return acceptedRecord(match, identity);
        },
        async appendJsonLine() {},
        async atomicWriteJson(path, value) {
          if (path.endsWith('standings.json')) {
            standingsWrites.push(structuredClone(value));
          }
        },
        now: () => INITIAL_TIME,
      });

      assert.equal(standingsWrites.length, 1);
      assert.equal(
        standingsWrites[0].acceptedResultCount,
        testCase.cadence
      );
      assert.equal(standingsWrites[0].status, 'provisional');
    });
  }
});

test('recovery retries a missed boundary snapshot before new work', async t => {
  const identity = runIdentity({
    runId: 'retry-recovered-snapshot',
    runnerConcurrency: 1,
  });
  const plan = executionSubset(
    await newPlan(t, identity),
    11,
    Array.from({length: 10}, (_, index) => index)
  );
  const snapshot = JSON.stringify(plan);
  const events = [];
  const standingsWrites = [];

  await executeGroupStagePlan(plan, {
    async runBattle(match) {
      events.push(`request:${match.matchId}`);
      return acceptedRecord(match, identity);
    },
    async appendJsonLine() {
      events.push('append');
    },
    async atomicWriteJson(path, value) {
      if (path.endsWith('standings.json')) {
        events.push('standings');
        standingsWrites.push(structuredClone(value));
      } else {
        events.push('checkpoint');
      }
    },
    now: () => INITIAL_TIME,
  });

  assert.deepEqual(events, [
    'checkpoint',
    'standings',
    `request:${plan.groupSchedule[10].matchId}`,
    'append',
    'checkpoint',
  ]);
  assert.equal(standingsWrites.length, 1);
  assert.equal(standingsWrites[0].status, 'provisional');
  assert.equal(standingsWrites[0].acceptedResultCount, 10);
  assert.equal(JSON.stringify(plan), snapshot);
});

test('ordinary non-boundary results do not write standings', async t => {
  const identity = runIdentity({runId: 'non-boundary-standings'});
  const plan = executionSubset(await newPlan(t, identity), 9);
  let standingsWrites = 0;

  await executeGroupStagePlan(plan, {
    async runBattle(match) {
      return acceptedRecord(match, identity);
    },
    async appendJsonLine() {},
    async atomicWriteJson(path) {
      if (path.endsWith('standings.json')) standingsWrites++;
    },
    now: () => INITIAL_TIME,
  });

  assert.equal(standingsWrites, 0);
});

test('provisional artifact contains all groups and joined schedule identity', async t => {
  const identity = runIdentity({runId: 'provisional-shape'});
  const plan = await newPlan(t, identity);
  const match = plan.groupSchedule[0];
  const response = acceptedRecord(match, identity);
  const responseSnapshot = structuredClone(response);
  const artifact = buildGroupStandingsArtifact(
    plan,
    new Map([[match.matchId, response]]),
    'provisional',
    INITIAL_TIME
  );

  assert.deepEqual(Object.keys(artifact), [
    'schemaVersion',
    'runId',
    'status',
    'acceptedResultCount',
    'expectedResultCount',
    'advancingCount',
    'updatedAt',
    'groups',
  ]);
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.runId, identity.runId);
  assert.equal(artifact.status, 'provisional');
  assert.equal(artifact.acceptedResultCount, 1);
  assert.equal(artifact.expectedResultCount, 112);
  assert.equal(artifact.advancingCount, 4);
  assert.equal(artifact.updatedAt, INITIAL_TIME);
  assert.deepEqual(
    artifact.groups.map(group => group.group),
    ['A', 'B', 'C', 'D']
  );
  assert.equal(artifact.groups[0].completedMatches, 1);
  assert.ok(artifact.groups.every(group =>
    group.expectedMatches === 28
  ));
  assert.deepEqual(response, responseSnapshot);
  assert.equal(Object.hasOwn(response, 'group'), false);
});

test('result checkpoint precedes a provisional standings snapshot', async t => {
  const identity = runIdentity({
    runId: 'provisional-order',
    runnerConcurrency: 1,
  });
  const plan = executionSubset(
    await newPlan(t, identity),
    10,
    Array.from({length: 9}, (_, index) => index)
  );
  const events = [];

  await executeGroupStagePlan(plan, {
    async runBattle(match) {
      return acceptedRecord(match, identity);
    },
    async appendJsonLine() {
      events.push('append');
    },
    async atomicWriteJson(path) {
      events.push(path.endsWith('checkpoint.json')
        ? 'checkpoint'
        : 'standings');
    },
    now: () => INITIAL_TIME,
  });

  assert.deepEqual(events, ['append', 'checkpoint', 'standings']);
});

test('provisional standings failure remains recoverable storage failure', async t => {
  const identity = runIdentity({
    runId: 'provisional-failure',
    runnerConcurrency: 1,
  });
  const plan = executionSubset(
    await newPlan(t, identity),
    11,
    Array.from({length: 9}, (_, index) => index)
  );
  const snapshot = JSON.stringify(plan);
  const events = [];
  const standingsError = new Error('standings volume unavailable');
  let requestCount = 0;

  await assert.rejects(
    executeGroupStagePlan(plan, {
      async runBattle(match) {
        requestCount++;
        return acceptedRecord(match, identity);
      },
      async appendJsonLine() {
        events.push('append');
      },
      async atomicWriteJson(path) {
        if (path.endsWith('standings.json')) {
          events.push('standings');
          throw standingsError;
        }
        events.push('checkpoint');
      },
      now: () => INITIAL_TIME,
    }),
    error => error === standingsError
  );

  assert.equal(requestCount, 1);
  assert.deepEqual(events, ['append', 'checkpoint', 'standings']);
  assert.equal(JSON.stringify(plan), snapshot);
  const metadata = JSON.parse(await readFile(
    join(plan.runDirectory, 'run-metadata.json'),
    'utf8'
  ));
  assert.equal(metadata.status, 'running');
});
