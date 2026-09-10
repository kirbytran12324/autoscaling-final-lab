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
  readJsonLines,
} = require('../src/runner-state');

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
