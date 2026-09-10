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
  appendJsonLine,
  atomicWriteJson,
  buildCompletedMatchIndex,
  readJsonLines,
} = require('../src/runner-state');

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
    termination: 'neutral',
    protocolHash: 'a'.repeat(64),
    servedBy: 'simulator-1',
    durationMs: 120,
    ...overrides,
  };
}

async function createTestDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'runner-state-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

test('atomicWriteJson creates valid newline-terminated JSON', async t => {
  const directory = await createTestDirectory(t);
  const filePath = join(directory, 'checkpoint.json');

  await atomicWriteJson(filePath, {stage: 'groups', position: 12});

  const contents = await readFile(filePath, 'utf8');
  assert.equal(contents, '{"stage":"groups","position":12}\n');
  assert.deepEqual(JSON.parse(contents), {
    stage: 'groups',
    position: 12,
  });
});

test('atomicWriteJson replaces an existing file', async t => {
  const directory = await createTestDirectory(t);
  const filePath = join(directory, 'checkpoint.json');
  await writeFile(filePath, '{"stage":"old"}\n', 'utf8');

  await atomicWriteJson(filePath, {stage: 'knockout'});

  assert.equal(
    await readFile(filePath, 'utf8'),
    '{"stage":"knockout"}\n'
  );
});

test('atomicWriteJson leaves no temporary file after replacement', async t => {
  const directory = await createTestDirectory(t);
  const filePath = join(directory, 'standings.json');
  await writeFile(filePath, '{}\n', 'utf8');

  await atomicWriteJson(filePath, {status: 'provisional'});

  assert.deepEqual(await readdir(directory), ['standings.json']);
});

test('appendJsonLine appends records on intact line boundaries', async t => {
  const directory = await createTestDirectory(t);
  const filePath = join(directory, 'results.jsonl');

  await appendJsonLine(filePath, {matchId: 'match-001'});
  await appendJsonLine(filePath, {matchId: 'match-002', outcome: 'tie'});

  assert.equal(
    await readFile(filePath, 'utf8'),
    '{"matchId":"match-001"}\n' +
      '{"matchId":"match-002","outcome":"tie"}\n'
  );
});

test('readJsonLines returns every valid record', async t => {
  const directory = await createTestDirectory(t);
  const filePath = join(directory, 'results.jsonl');
  await writeFile(
    filePath,
    '{"matchId":"match-001"}\n{"matchId":"match-002"}\n',
    'utf8'
  );

  assert.deepEqual(await readJsonLines(filePath), [
    {matchId: 'match-001'},
    {matchId: 'match-002'},
  ]);
});

test('readJsonLines returns an empty array for missing and empty files', async t => {
  const directory = await createTestDirectory(t);
  const missingPath = join(directory, 'missing.jsonl');
  const emptyPath = join(directory, 'empty.jsonl');
  await writeFile(emptyPath, '', 'utf8');

  assert.deepEqual(await readJsonLines(missingPath), []);
  assert.deepEqual(await readJsonLines(emptyPath), []);
});

test('readJsonLines rejects blank lines', async t => {
  const directory = await createTestDirectory(t);
  const filePath = join(directory, 'results.jsonl');
  await writeFile(filePath, '{"matchId":"match-001"}\n\n', 'utf8');

  await assert.rejects(
    readJsonLines(filePath),
    /blank.*line 2/i
  );
});

test('readJsonLines identifies the line containing malformed JSON', async t => {
  const directory = await createTestDirectory(t);
  const filePath = join(directory, 'results.jsonl');
  await writeFile(
    filePath,
    '{"matchId":"match-001"}\nnot-json\n',
    'utf8'
  );

  await assert.rejects(
    readJsonLines(filePath),
    /malformed JSON on line 2/i
  );
});

test('readJsonLines rejects an unterminated final record as truncated', async t => {
  const directory = await createTestDirectory(t);
  const filePath = join(directory, 'results.jsonl');
  await writeFile(
    filePath,
    '{"matchId":"match-001"}\n{"matchId":"match-002"}',
    'utf8'
  );

  await assert.rejects(
    readJsonLines(filePath),
    /line 2 lacks a terminating newline/i
  );
});

test('buildCompletedMatchIndex indexes unique records in a Map', () => {
  const first = completedResult();
  const second = completedResult({matchId: 'group-A-000002'});

  const index = buildCompletedMatchIndex([first, second]);

  assert.ok(index instanceof Map);
  assert.equal(index.size, 2);
  assert.strictEqual(index.get(first.matchId), first);
  assert.strictEqual(index.get(second.matchId), second);
});

test('buildCompletedMatchIndex accepts identical deterministic duplicates', () => {
  const first = completedResult();
  const duplicate = {
    ...first,
    seed: [...first.seed],
  };

  const index = buildCompletedMatchIndex([first, duplicate]);

  assert.equal(index.size, 1);
  assert.strictEqual(index.get(first.matchId), first);
});

test('buildCompletedMatchIndex ignores operational duplicate differences', () => {
  const first = completedResult();
  const duplicate = completedResult({
    seed: [...first.seed],
    servedBy: 'simulator-9',
    durationMs: 875,
  });

  const index = buildCompletedMatchIndex([first, duplicate]);

  assert.equal(index.size, 1);
  assert.strictEqual(index.get(first.matchId), first);
});

test('buildCompletedMatchIndex rejects a changed participant', () => {
  const first = completedResult();
  const conflicting = completedResult({pokemon2: 'Mew'});

  assert.throws(
    () => buildCompletedMatchIndex([first, conflicting]),
    /reproducibility conflict/i
  );
});

test('buildCompletedMatchIndex rejects a changed seed', () => {
  const first = completedResult();
  const conflicting = completedResult({seed: [1, 2, 3, 4]});

  assert.throws(
    () => buildCompletedMatchIndex([first, conflicting]),
    /reproducibility conflict/i
  );
});

test('buildCompletedMatchIndex rejects changed outcomes and winners', () => {
  const first = completedResult();

  for (const conflicting of [
    completedResult({outcome: 'tie'}),
    completedResult({winnerSpecies: 'Clefable'}),
  ]) {
    assert.throws(
      () => buildCompletedMatchIndex([first, conflicting]),
      /reproducibility conflict/i
    );
  }
});

test('buildCompletedMatchIndex rejects another deterministic difference', () => {
  const first = completedResult();
  const conflicting = completedResult({protocolHash: 'b'.repeat(64)});

  assert.throws(
    () => buildCompletedMatchIndex([first, conflicting]),
    /reproducibility conflict/i
  );
});

test('duplicate conflict errors include the matchId', () => {
  const first = completedResult({matchId: 'r64-series-03-game-02'});
  const conflicting = completedResult({
    matchId: first.matchId,
    turns: first.turns + 1,
  });

  assert.throws(
    () => buildCompletedMatchIndex([first, conflicting]),
    new RegExp(first.matchId)
  );
});

test('buildCompletedMatchIndex rejects missing deterministic fields', () => {
  const record = completedResult();
  delete record.protocolHash;

  assert.throws(
    () => buildCompletedMatchIndex([record]),
    /missing.*protocolHash/i
  );
});

test('buildCompletedMatchIndex rejects blank and non-string matchIds', () => {
  for (const matchId of ['', '   ', 123]) {
    assert.throws(
      () => buildCompletedMatchIndex([completedResult({matchId})]),
      /non-empty string matchId/i
    );
  }
});

test('buildCompletedMatchIndex rejects malformed top-level inputs', () => {
  for (const records of [null, {}, 'records']) {
    assert.throws(
      () => buildCompletedMatchIndex(records),
      /must be an array/i
    );
  }

  for (const record of [null, [], 'record']) {
    assert.throws(
      () => buildCompletedMatchIndex([record]),
      /must be a non-array object/i
    );
  }
});

test('buildCompletedMatchIndex preserves input records', () => {
  const records = [
    completedResult(),
    completedResult({matchId: 'group-A-000002'}),
  ];
  const snapshot = structuredClone(records);

  buildCompletedMatchIndex(records);

  assert.deepEqual(records, snapshot);
});
