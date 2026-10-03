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

test('final standings reject an incomplete group stage', async t => {
  const identity = runIdentity({runId: 'incomplete-final'});
  const plan = await newPlan(t, identity);
  const match = plan.groupSchedule[0];

  assert.throws(
    () => buildGroupStandingsArtifact(
      plan,
      new Map([[match.matchId, acceptedRecord(match, identity)]]),
      'final',
      INITIAL_TIME
    ),
    /final standings require 112.*received 1/i
  );
});

test('sample finalization writes standings, r16 bracket, then checkpoint', async t => {
  const identity = runIdentity({runId: 'sample-finalization'});
  const basePlan = await newPlan(t, identity);
  const plan = executionSubset(
    basePlan,
    basePlan.groupSchedule.length,
    basePlan.groupSchedule.map((_, index) => index)
  );
  const snapshot = JSON.stringify(plan);
  const writes = [];

  const summary = await executeGroupStagePlan(plan, {
    async atomicWriteJson(path, value) {
      writes.push({path, value: structuredClone(value)});
    },
    now: () => INITIAL_TIME,
  });

  assert.deepEqual(writes.map(write => write.path.split('/').at(-1)), [
    'standings.json',
    'bracket.json',
    'checkpoint.json',
  ]);
  const [standingsWrite, bracketWrite, checkpointWrite] = writes;
  assert.equal(standingsWrite.value.status, 'final');
  assert.equal(standingsWrite.value.acceptedResultCount, 112);
  assert.equal(standingsWrite.value.expectedResultCount, 112);
  assert.equal(standingsWrite.value.advancingCount, 4);
  assert.deepEqual(
    standingsWrite.value.groups.map(group => group.group),
    ['A', 'B', 'C', 'D']
  );
  assert.ok(standingsWrite.value.groups.every(group =>
    group.status === 'final' &&
    group.completedMatches === 28 &&
    group.expectedMatches === 28
  ));
  assert.equal(bracketWrite.value.schemaVersion, 1);
  assert.equal(bracketWrite.value.runId, identity.runId);
  assert.equal(bracketWrite.value.status, 'running');
  assert.equal(bracketWrite.value.rounds.length, 1);
  assert.equal(bracketWrite.value.rounds[0].round, 'r16');
  assert.equal(bracketWrite.value.rounds[0].series.length, 8);
  assert.equal(bracketWrite.value.champion, null);
  assert.deepEqual(checkpointWrite.value, {
    schemaVersion: 1,
    stage: 'knockout',
    round: 'r16',
    schedulePosition: 0,
    acceptedResultCount: 112,
    updatedAt: INITIAL_TIME,
  });
  assert.deepEqual(summary, {
    stage: 'knockout',
    round: 'r16',
    requestedMatchCount: 0,
    acceptedMatchCount: 0,
    acceptedResultCount: 112,
    schedulePosition: 0,
  });
  assert.equal(JSON.stringify(plan), snapshot);
});

test('full final standings select sixteen advancers into r64', async t => {
  const identity = runIdentity({
    runId: 'full-initial-bracket',
    mode: 'full',
  });
  const plan = await newPlan(t, identity);
  const expectedResultCount = 130816;
  const finalStandings = {
    schemaVersion: 1,
    runId: identity.runId,
    status: 'final',
    acceptedResultCount: expectedResultCount,
    expectedResultCount,
    advancingCount: 16,
    updatedAt: INITIAL_TIME,
    groups: ['A', 'B', 'C', 'D'].map(groupName => {
      const groupRoster = plan.groups[groupName];
      const groupMatchCount =
        groupRoster.length * (groupRoster.length - 1) / 2;

      return {
        group: groupName,
        status: 'final',
        completedMatches: groupMatchCount,
        expectedMatches: groupMatchCount,
        standings: groupRoster.map((species, index) => ({
          group: groupName,
          rank: index + 1,
          speciesId: species.id,
          species: species.name,
        })),
      };
    }),
  };

  const bracket = buildInitialKnockoutArtifact(
    plan,
    finalStandings,
    INITIAL_TIME
  );

  assert.equal(bracket.rounds[0].round, 'r64');
  assert.equal(bracket.rounds[0].series.length, 32);
  assert.ok(bracket.rounds[0].series.every(series =>
    series.entrant1.rank <= 16 && series.entrant2.rank <= 16
  ));
});

test('final artifact failures never advance the knockout checkpoint', async t => {
  for (const failedArtifact of ['standings.json', 'bracket.json']) {
    await t.test(failedArtifact, async t => {
      const identity = runIdentity({
        runId: `fail-final-${failedArtifact.split('.')[0]}`,
      });
      const basePlan = await newPlan(t, identity);
      const plan = executionSubset(
        basePlan,
        basePlan.groupSchedule.length,
        basePlan.groupSchedule.map((_, index) => index)
      );
      const writes = [];
      const storageError = new Error(`${failedArtifact} failed`);

      await assert.rejects(
        executeGroupStagePlan(plan, {
          async atomicWriteJson(path) {
            const fileName = path.split('/').at(-1);
            writes.push(fileName);
            if (fileName === failedArtifact) throw storageError;
          },
          now: () => INITIAL_TIME,
        }),
        error => error === storageError
      );

      assert.equal(writes.includes('checkpoint.json'), false);
      assert.deepEqual(
        writes,
        failedArtifact === 'standings.json'
          ? ['standings.json']
          : ['standings.json', 'bracket.json']
      );
      const metadata = JSON.parse(await readFile(
        join(plan.runDirectory, 'run-metadata.json'),
        'utf8'
      ));
      assert.equal(metadata.status, 'running');
    });
  }
});

test('interrupted final transition is deterministic and safely repeatable', async t => {
  const identity = runIdentity({runId: 'repeat-final-transition'});
  const initial = await newPlan(t, identity);
  await writeRecords(
    initial.runDirectory,
    initial.groupSchedule.map(match => acceptedRecord(match, identity))
  );
  const recovered = await planTournamentRun({
    stateRoot: join(initial.runDirectory, '..', '..'),
    identity,
  });
  const checkpointError = new Error('transition checkpoint interrupted');

  await assert.rejects(
    executeGroupStagePlan(recovered, {
      async atomicWriteJson(path, value) {
        if (path.endsWith('checkpoint.json')) throw checkpointError;
        await atomicWriteStateJson(path, value);
      },
      now: () => INITIAL_TIME,
    }),
    error => error === checkpointError
  );

  const firstStandings = await readFile(
    join(initial.runDirectory, 'standings.json'),
    'utf8'
  );
  const firstBracket = await readFile(
    join(initial.runDirectory, 'bracket.json'),
    'utf8'
  );
  const groupCheckpoint = JSON.parse(await readFile(
    join(initial.runDirectory, 'checkpoint.json'),
    'utf8'
  ));
  assert.equal(groupCheckpoint.stage, 'groups');

  const retriedPlan = await planTournamentRun({
    stateRoot: join(initial.runDirectory, '..', '..'),
    identity,
  });
  await executeGroupStagePlan(retriedPlan, {
    now: () => INITIAL_TIME,
  });

  assert.equal(
    await readFile(join(initial.runDirectory, 'standings.json'), 'utf8'),
    firstStandings
  );
  assert.equal(
    await readFile(join(initial.runDirectory, 'bracket.json'), 'utf8'),
    firstBracket
  );
  const transitionCheckpoint = JSON.parse(await readFile(
    join(initial.runDirectory, 'checkpoint.json'),
    'utf8'
  ));
  assert.deepEqual(transitionCheckpoint, {
    schemaVersion: 1,
    stage: 'knockout',
    round: 'r16',
    schedulePosition: 0,
    acceptedResultCount: 112,
    updatedAt: INITIAL_TIME,
  });
  const metadata = JSON.parse(await readFile(
    join(initial.runDirectory, 'run-metadata.json'),
    'utf8'
  ));
  assert.equal(metadata.status, 'running');
});
