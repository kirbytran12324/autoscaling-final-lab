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
  initializeOrResumeRun,
  resolveRunDirectory,
  validateCheckpoint,
  validateRunMetadata,
} = require('../src/runner-state');

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

async function readEvidence(runDirectory) {
  const evidence = {};

  for (const entry of (await readdir(runDirectory)).sort()) {
    evidence[entry] = await readFile(join(runDirectory, entry), 'utf8');
  }

  return evidence;
}

test('resolveRunDirectory accepts safe DNS-style run IDs', () => {
  for (const runId of [
    'a',
    'run1',
    'sample-run-2026',
    `a${'b'.repeat(61)}z`,
  ]) {
    assert.equal(
      resolveRunDirectory('/state', runId),
      join('/state', 'runs', runId)
    );
  }
});

test('resolveRunDirectory rejects unsafe run IDs', () => {
  for (const runId of [
    '',
    '.',
    '..',
    'UPPER',
    '-leading',
    'trailing-',
    'two--hyphens-',
    'has space',
    'has/slash',
    'has\\slash',
    '/absolute',
    '../escape',
    `a${'b'.repeat(63)}`,
    123,
  ]) {
    assert.throws(
      () => resolveRunDirectory('/state', runId),
      /runId must be a lowercase DNS-style name/i
    );
  }
});

test('run metadata and checkpoint validators accept their contracts', () => {
  const identity = runIdentity();
  const completed = runMetadata(identity, {
    status: 'completed',
    completedAt: RESUME_TIME,
  });
  const knockoutCheckpoint = checkpoint({stage: 'knockout', round: 'r64'});

  assert.strictEqual(validateRunMetadata(completed, identity), completed);
  assert.strictEqual(validateCheckpoint(knockoutCheckpoint), knockoutCheckpoint);
});

test('validators reject invalid identities, timestamps, and progress fields', () => {
  const identity = runIdentity();

  for (const invalidIdentity of [
    runIdentity({mode: 'preview'}),
    runIdentity({tournamentSeed: '  '}),
    runIdentity({rulesVersion: ''}),
    runIdentity({simulatorVersion: null}),
    runIdentity({simulatorImage: ''}),
    runIdentity({runnerConcurrency: 0}),
    runIdentity({runnerConcurrency: 1.5}),
  ]) {
    assert.throws(
      () => validateRunMetadata(runMetadata(invalidIdentity), invalidIdentity)
    );
  }

  for (const invalidMetadata of [
    runMetadata(identity, {schemaVersion: 2}),
    runMetadata(identity, {status: 'paused'}),
    runMetadata(identity, {startedAt: 'not-a-date'}),
    runMetadata(identity, {startedAt: '2026-02-30T00:00:00.000Z'}),
    runMetadata(identity, {completedAt: RESUME_TIME}),
    runMetadata(identity, {status: 'completed', completedAt: null}),
  ]) {
    assert.throws(() => validateRunMetadata(invalidMetadata, identity));
  }

  for (const invalidCheckpoint of [
    checkpoint({schemaVersion: 2}),
    checkpoint({stage: 'waiting'}),
    checkpoint({round: ''}),
    checkpoint({schedulePosition: -1}),
    checkpoint({schedulePosition: 1.5}),
    checkpoint({acceptedResultCount: -1}),
    checkpoint({updatedAt: 'yesterday'}),
  ]) {
    assert.throws(() => validateCheckpoint(invalidCheckpoint));
  }
});

test('initializeOrResumeRun initializes a new per-run directory', async t => {
  const stateRoot = await createStateRoot(t);
  const identity = runIdentity();

  const state = await initialize(stateRoot, identity);

  assert.equal(
    state.runDirectory,
    join(stateRoot, 'runs', identity.runId)
  );
  assert.deepEqual(state.metadata, runMetadata(identity));
  assert.deepEqual(state.checkpointHint, checkpoint());
  assert.deepEqual(state.acceptedRecords, []);
  assert.equal(state.completedMatches.size, 0);
  assert.equal(state.resumed, false);
  assert.equal(state.terminal, false);
  assert.deepEqual(
    (await readdir(state.runDirectory)).sort(),
    ['checkpoint.json', 'run-metadata.json']
  );
  assert.match(
    await readFile(join(state.runDirectory, 'run-metadata.json'), 'utf8'),
    /\n$/
  );
});

test('multiple run IDs share one state root without interference', async t => {
  const stateRoot = await createStateRoot(t);
  const firstIdentity = runIdentity({runId: 'sample-one'});
  const secondIdentity = runIdentity({
    runId: 'sample-two',
    tournamentSeed: 'another-seed',
  });
  const first = await initialize(stateRoot, firstIdentity);
  const firstResults = join(first.runDirectory, 'results.jsonl');
  await appendJsonLine(firstResults, completedResult());
  const firstEvidence = await readEvidence(first.runDirectory);

  const second = await initialize(stateRoot, secondIdentity);

  assert.notEqual(first.runDirectory, second.runDirectory);
  assert.deepEqual(await readEvidence(first.runDirectory), firstEvidence);
  assert.deepEqual(
    (await readdir(join(stateRoot, 'runs'))).sort(),
    ['sample-one', 'sample-two']
  );
});

test('matching persisted identity resumes and returns completed index', async t => {
  const stateRoot = await createStateRoot(t);
  const identity = runIdentity();
  const initial = await initialize(stateRoot, identity);
  const first = completedResult();
  const second = completedResult({matchId: 'group-A-000002'});
  await appendJsonLine(join(initial.runDirectory, 'results.jsonl'), first);
  await appendJsonLine(join(initial.runDirectory, 'results.jsonl'), second);
  await writeJson(
    join(initial.runDirectory, 'checkpoint.json'),
    checkpoint({schedulePosition: 2, acceptedResultCount: 2})
  );

  const resumed = await initialize(stateRoot, identity, RESUME_TIME);

  assert.equal(resumed.resumed, true);
  assert.deepEqual(resumed.acceptedRecords, [first, second]);
  assert.equal(resumed.completedMatches.size, 2);
  assert.deepEqual(resumed.completedMatches.get(first.matchId), first);
  assert.deepEqual(resumed.checkpointHint, checkpoint({
    schedulePosition: 2,
    acceptedResultCount: 2,
  }));
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.terminal, false);
});

test('identity mismatch refuses resume without changing files', async t => {
  const stateRoot = await createStateRoot(t);
  const identity = runIdentity();
  const initial = await initialize(stateRoot, identity);
  await appendJsonLine(
    join(initial.runDirectory, 'results.jsonl'),
    completedResult()
  );
  const before = await readEvidence(initial.runDirectory);

  await assert.rejects(
    initialize(stateRoot, {...identity, mode: 'full'}, RESUME_TIME),
    /identity mismatch.*mode/i
  );

  assert.deepEqual(await readEvidence(initial.runDirectory), before);
});

test('every immutable metadata identity field must exactly match', () => {
  const identity = runIdentity();
  const replacements = {
    runId: 'different-run',
    mode: 'full',
    tournamentSeed: 'different-seed',
    rulesVersion: 'rules-v2',
    simulatorVersion: 'pokemon-showdown@9.9.9',
    simulatorImage: 'metronome-simulator:other',
    runnerConcurrency: 8,
  };

  for (const [field, value] of Object.entries(replacements)) {
    assert.throws(
      () => validateRunMetadata(
        runMetadata({...identity, [field]: value}),
        identity
      ),
      new RegExp(`identity mismatch.*${field}`, 'i')
    );
  }
});

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
  await appendJsonLine(join(runDirectory, 'results.jsonl'), completedResult());
  const before = await readEvidence(runDirectory);

  const resumed = await initialize(stateRoot, identity, RESUME_TIME);

  assert.equal(resumed.checkpointHint, undefined);
  assert.deepEqual(await readEvidence(runDirectory), before);
});

test('inconsistent checkpoint progress is returned without rewrite', async t => {
  const stateRoot = await createStateRoot(t);
  const initial = await initialize(stateRoot);
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
