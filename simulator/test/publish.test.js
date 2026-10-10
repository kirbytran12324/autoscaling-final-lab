'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, rm, cp, readFile, writeFile, access} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {publishRun} = require('../src/publish-cli');

test('publication validates, copies canonical evidence, is idempotent, and refuses conflicting or incomplete archives', async t => {
  const root = await mkdtemp(join(tmpdir(), 'publish-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const stateRoot = join(root, 'state'), archiveRoot = join(root, 'archive'), runId = 'sample-32-002';
  await cp(resolve(__dirname, '../../evidence/tournaments/runs', runId), join(stateRoot, 'runs', runId), {recursive: true});
  assert.equal((await publishRun({stateRoot, archiveRoot, runId})).archived, true);
  assert.equal((await publishRun({stateRoot, archiveRoot, runId})).existing, true);
  assert.deepEqual(await readFile(join(stateRoot, 'runs', runId, 'results.jsonl')),
    await readFile(join(archiveRoot, 'runs', runId, 'results.jsonl')));
  const metadataPath = join(stateRoot, 'runs', runId, 'run-metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath));
  await writeFile(metadataPath, JSON.stringify({...metadata, startedAt: '2026-09-22T00:00:00.000Z'}));
  await assert.rejects(publishRun({stateRoot, archiveRoot, runId}), /different evidence/);
  await writeFile(metadataPath, JSON.stringify({...metadata, status: 'running', completedAt: null}));
  const emptyArchive = join(root, 'other');
  await assert.rejects(publishRun({stateRoot, archiveRoot: emptyArchive, runId}), /incomplete/);
  await assert.rejects(access(join(emptyArchive, 'runs', runId)));
});
