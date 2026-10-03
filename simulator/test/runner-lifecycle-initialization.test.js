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
  await persistTestRoster(initial.runDirectory, identity);
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

test('an established roster cannot be replaced by a conflicting roster', async t => {
  const stateRoot = await createStateRoot(t);
  const identity = runIdentity({runId: 'immutable-roster-conflict'});
  const initial = await initialize(stateRoot, identity);
  const established = await persistTestRoster(initial.runDirectory, identity);
  const conflicting = structuredClone(established);
  [conflicting.entrants[0], conflicting.entrants[1]] = [
    conflicting.entrants[1],
    conflicting.entrants[0],
  ];
  conflicting.entrants[0].position = 1;
  conflicting.entrants[1].position = 2;
  conflicting.rosterHash = calculateRosterHash(conflicting);
  const rosterPath = join(initial.runDirectory, 'roster.json');
  const before = await readFile(rosterPath, 'utf8');

  await assert.rejects(
    loadOrCreateRunRoster({
      runDirectory: initial.runDirectory,
      identity,
      roster: conflicting,
    }),
    /conflicts with the requested roster/i
  );
  assert.equal(await readFile(rosterPath, 'utf8'), before);
});

test('accepted results without roster evidence refuse recovery', async t => {
  const stateRoot = await createStateRoot(t);
  const initial = await initialize(stateRoot);
  await appendJsonLine(
    join(initial.runDirectory, 'results.jsonl'),
    completedResult()
  );

  await assert.rejects(
    initialize(stateRoot),
    /accepted results.*no immutable roster\.json/i
  );
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
