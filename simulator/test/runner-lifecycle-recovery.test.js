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
const {
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
} = require('../test-support/runner-lifecycle');

test('orphaned canonical or unknown state is rejected and preserved', async t => {
  for (const [name, fileName] of [
    ['canonical evidence', 'results.jsonl'],
    ['unknown file', '.run-metadata.json.tmp'],
  ]) {
    await t.test(name, async t => {
      const stateRoot = await createStateRoot(t);
      const runDirectory = resolveRunDirectory(stateRoot, runIdentity().runId);
      await mkdir(runDirectory, {recursive: true});
      await writeFile(
        join(runDirectory, fileName),
        '{"diagnostic":"preserve me"}\n',
        'utf8'
      );
      const before = await readEvidence(runDirectory);

      await assert.rejects(
        initialize(stateRoot),
        /persisted evidence.*no run-metadata\.json/i
      );

      assert.deepEqual(await readEvidence(runDirectory), before);
    });
  }
});

test('restart recovers after an interrupted initial metadata write', async t => {
  const stateRoot = await createStateRoot(t);
  const identity = runIdentity();
  const runDirectory = resolveRunDirectory(stateRoot, identity.runId);
  await mkdir(runDirectory, {recursive: true});
  const temporaryName =
    '.run-metadata.json.12345.12345678-1234-4123-8123-123456789abc.tmp';
  const temporaryPath = join(runDirectory, temporaryName);
  await writeFile(temporaryPath, '{"interrupted":', 'utf8');

  const initialized = await initialize(stateRoot, identity, RESUME_TIME);

  assert.equal(initialized.resumed, false);
  assert.equal(initialized.terminal, false);
  assert.deepEqual(initialized.metadata, runMetadata(identity, {
    startedAt: RESUME_TIME,
  }));
  assert.deepEqual(initialized.checkpointHint, checkpoint({
    updatedAt: RESUME_TIME,
  }));
  assert.equal(await readFile(temporaryPath, 'utf8'), '{"interrupted":');
});

test('missing checkpoint remains absent for schedule-aware recovery', async t => {
  const stateRoot = await createStateRoot(t);
  const identity = runIdentity();
  const runDirectory = resolveRunDirectory(stateRoot, identity.runId);
  await mkdir(runDirectory, {recursive: true});
  await writeJson(join(runDirectory, 'run-metadata.json'), runMetadata(identity));
  await persistTestRoster(runDirectory, identity);
  await appendJsonLine(join(runDirectory, 'results.jsonl'), completedResult());
  const before = await readEvidence(runDirectory);

  const resumed = await initialize(stateRoot, identity, RESUME_TIME);

  assert.equal(resumed.checkpointHint, undefined);
  assert.deepEqual(await readEvidence(runDirectory), before);
});

test('inconsistent checkpoint progress is returned without rewrite', async t => {
  const stateRoot = await createStateRoot(t);
  const initial = await initialize(stateRoot);
  await persistTestRoster(initial.runDirectory);
  await appendJsonLine(
    join(initial.runDirectory, 'results.jsonl'),
    completedResult()
  );
  const inconsistent = checkpoint({
    stage: 'knockout',
    round: 'r64',
    acceptedResultCount: 9,
    schedulePosition: 77,
  });
  await writeJson(join(initial.runDirectory, 'checkpoint.json'), inconsistent);
  const before = await readEvidence(initial.runDirectory);

  const resumed = await initialize(stateRoot, runIdentity(), RESUME_TIME);

  assert.deepEqual(resumed.checkpointHint, inconsistent);
  assert.deepEqual(await readEvidence(initial.runDirectory), before);
});

test('completed and failed runs are terminal read-only history', async t => {
  for (const status of ['completed', 'failed']) {
    await t.test(status, async t => {
      const stateRoot = await createStateRoot(t);
      const identity = runIdentity();
      const runDirectory = resolveRunDirectory(stateRoot, identity.runId);
      await mkdir(runDirectory, {recursive: true});
      await writeJson(
        join(runDirectory, 'run-metadata.json'),
        runMetadata(identity, {
          status,
          completedAt: status === 'completed' ? RESUME_TIME : null,
        })
      );
      await persistTestRoster(runDirectory, identity);
      await appendJsonLine(
        join(runDirectory, 'results.jsonl'),
        completedResult()
      );
      const before = await readEvidence(runDirectory);

      const loaded = await initialize(stateRoot, identity, RESUME_TIME);

      assert.equal(loaded.metadata.status, status);
      assert.equal(loaded.checkpointHint, undefined);
      assert.equal(loaded.resumed, false);
      assert.equal(loaded.terminal, true);
      assert.deepEqual(loaded.acceptedRecords, [completedResult()]);
      assert.deepEqual(await readEvidence(runDirectory), before);
    });
  }
});

test('identical duplicate JSONL records return one accepted record', async t => {
  const stateRoot = await createStateRoot(t);
  const initial = await initialize(stateRoot);
  await persistTestRoster(initial.runDirectory);
  const first = completedResult();
  const duplicate = structuredClone(first);
  await appendJsonLine(join(initial.runDirectory, 'results.jsonl'), first);
  await appendJsonLine(join(initial.runDirectory, 'results.jsonl'), duplicate);

  const resumed = await initialize(stateRoot, runIdentity(), RESUME_TIME);

  assert.deepEqual(resumed.acceptedRecords, [first]);
  assert.equal(Object.hasOwn(resumed, 'records'), false);
  assert.equal(Object.hasOwn(resumed, 'rawRecords'), false);
  assert.equal(resumed.completedMatches.size, 1);
});

test('malformed metadata and checkpoint refuse resume without mutation', async t => {
  for (const [fileName, value, pattern] of [
    ['run-metadata.json', {...runMetadata(), status: 'paused'}, /status/i],
    ['checkpoint.json', {...checkpoint(), schedulePosition: -1},
      /schedulePosition/i],
  ]) {
    await t.test(fileName, async t => {
      const stateRoot = await createStateRoot(t);
      const initial = await initialize(stateRoot);
      await writeJson(join(initial.runDirectory, fileName), value);
      const before = await readEvidence(initial.runDirectory);

      await assert.rejects(initialize(stateRoot), pattern);

      assert.deepEqual(await readEvidence(initial.runDirectory), before);
    });
  }
});

test('malformed JSON metadata and checkpoint refuse resume', async t => {
  for (const fileName of ['run-metadata.json', 'checkpoint.json']) {
    await t.test(fileName, async t => {
      const stateRoot = await createStateRoot(t);
      const initial = await initialize(stateRoot);
      await writeFile(join(initial.runDirectory, fileName), '{broken\n', 'utf8');
      const before = await readEvidence(initial.runDirectory);

      await assert.rejects(initialize(stateRoot), /malformed/i);

      assert.deepEqual(await readEvidence(initial.runDirectory), before);
    });
  }
});

test('malformed, truncated, and conflicting results refuse resume', async t => {
  const cases = [
    ['malformed', 'not-json\n', /malformed JSON/i],
    ['truncated', `${JSON.stringify(completedResult())}`, /terminating newline/i],
    [
      'conflicting',
      `${JSON.stringify(completedResult())}\n` +
        `${JSON.stringify(completedResult({turns: 43}))}\n`,
      /reproducibility conflict/i,
    ],
  ];

  for (const [name, contents, pattern] of cases) {
    await t.test(name, async t => {
      const stateRoot = await createStateRoot(t);
      const initial = await initialize(stateRoot);
      await writeFile(
        join(initial.runDirectory, 'results.jsonl'),
        contents,
        'utf8'
      );
      const before = await readEvidence(initial.runDirectory);

      await assert.rejects(initialize(stateRoot), pattern);

      assert.deepEqual(await readEvidence(initial.runDirectory), before);
    });
  }
});

test('injected now supplies deterministic initialization timestamps', async t => {
  const stateRoot = await createStateRoot(t);
  let calls = 0;

  const state = await initializeOrResumeRun({
    stateRoot,
    identity: runIdentity(),
    now: () => {
      calls += 1;
      return INITIAL_TIME;
    },
  });

  assert.equal(calls, 1);
  assert.equal(state.metadata.startedAt, INITIAL_TIME);
  assert.equal(state.checkpointHint.updatedAt, INITIAL_TIME);
});
