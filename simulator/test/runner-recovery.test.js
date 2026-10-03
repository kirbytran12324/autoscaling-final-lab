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

  const roster = JSON.parse(await readFile(
    join(plan.runDirectory, 'roster.json'),
    'utf8'
  ));
  assert.equal(roster.runId, plan.identity.runId);
  assert.deepEqual(roster.rosterSeed, plan.rosterSeed);
  assert.deepEqual(
    roster.entrants.map(entrant => entrant.species),
    plan.roster.map(species => species.name)
  );
  assert.match(roster.rosterHash, /^[0-9a-f]{64}$/);
});

test('restart uses the persisted roster instead of mutable sample config', async t => {
  const identity = runIdentity({runId: 'persisted-roster-restart'});
  const initial = await newPlan(t, identity);
  const before = await readFile(join(initial.runDirectory, 'roster.json'), 'utf8');

  const resumed = await planTournamentRun({
    stateRoot: join(initial.runDirectory, '..', '..'),
    identity,
    sampleRoster: ['this changed configuration must not be read'],
  });

  assert.deepEqual(
    resumed.roster.map(species => species.name),
    initial.roster.map(species => species.name)
  );
  assert.deepEqual(resumed.groupSchedule, initial.groupSchedule);
  assert.equal(
    await readFile(join(initial.runDirectory, 'roster.json'), 'utf8'),
    before
  );
});

test('restart rejects a corrupt immutable roster without overwriting it', async t => {
  const identity = runIdentity({runId: 'corrupt-persisted-roster'});
  const initial = await newPlan(t, identity);
  const rosterPath = join(initial.runDirectory, 'roster.json');
  const roster = JSON.parse(await readFile(rosterPath, 'utf8'));
  roster.entrants[0].species = 'Corrupted';
  await writeJson(rosterPath, roster);
  const before = await readFile(rosterPath, 'utf8');

  await assert.rejects(
    planTournamentRun({
      stateRoot: join(initial.runDirectory, '..', '..'),
      identity,
    }),
    /roster hash does not match/i
  );
  assert.equal(await readFile(rosterPath, 'utf8'), before);
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
    roster: JSON.parse(await readFile(
      join(initial.runDirectory, 'roster.json'),
      'utf8'
    )),
    resumed: true,
    terminal: false,
  };
  const stateSnapshot = structuredClone(runState);
  const identitySnapshot = structuredClone(identity);

  const first = buildGroupStageRecoveryPlan(runState, identity);
  const second = buildGroupStageRecoveryPlan(runState, identity);

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
});

test('checkpoint stage does not override incomplete group evidence', async t => {
  const identity = runIdentity();
  const initial = await newPlan(t, identity);
  await writeJson(join(initial.runDirectory, 'checkpoint.json'), checkpoint({
    stage: 'knockout',
    round: 'r64',
  }));

  const reconciled = await planTournamentRun({
    stateRoot: join(initial.runDirectory, '..', '..'),
    identity,
  });

  assert.equal(reconciled.stage, 'groups');
  assert.equal(reconciled.round, undefined);
  assert.equal(reconciled.acceptedResultCount, 0);

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
    /knockout recovery requires the complete group stage.*r64-series-01-game-01/i
  );
});
