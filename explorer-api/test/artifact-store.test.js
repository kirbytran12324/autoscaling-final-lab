'use strict';

const assert = require('node:assert/strict');
const {mkdir, readFile, symlink, unlink, writeFile} = require('node:fs/promises');
const {join} = require('node:path');
const {test} = require('node:test');

const {
  FilesystemArtifactStore,
  decodeCursor,
  validateRunId,
} = require('../src/artifact-store');
const {ArtifactStoreError} = require('../src/errors');
const {loadTournamentArtifacts} = require('../../simulator/src/report-loader');
const {FIXTURE_RUN_ID, createFixtureRoot, removeFixtureRoot} = require('./helpers');

test('artifact paths reject traversal and symlinked run directories', async t => {
  const root = await createFixtureRoot();
  t.after(() => removeFixtureRoot(root));
  const store = new FilesystemArtifactStore({stateRoot: root});

  for (const runId of ['../escape', 'nested/run', '/absolute', 'UPPERCASE', 'a'.repeat(64)]) {
    assert.throws(() => validateRunId(runId), error =>
      error instanceof ArtifactStoreError && error.code === 'INVALID_RUN_ID'
    );
  }
  await symlink(join(root, 'runs', FIXTURE_RUN_ID), join(root, 'runs', 'linked-run'));
  await assert.rejects(
    store.getRun('linked-run'),
    error => error instanceof ArtifactStoreError && error.code === 'RUN_NOT_FOUND'
  );

  const standingsPath = join(root, 'runs', FIXTURE_RUN_ID, 'standings.json');
  await unlink(standingsPath);
  await symlink('/etc/passwd', standingsPath);
  await assert.rejects(
    store.getRun(FIXTURE_RUN_ID),
    error => error instanceof ArtifactStoreError && error.code === 'INVALID_RUN'
  );
});

test('completed-run discovery includes only strictly valid completed runs', async t => {
  const root = await createFixtureRoot();
  t.after(() => removeFixtureRoot(root));
  const invalidDirectory = join(root, 'runs', 'invalid-run');
  const incompleteDirectory = join(root, 'runs', 'incomplete-run');
  await mkdir(invalidDirectory);
  await mkdir(incompleteDirectory);
  await writeFile(join(invalidDirectory, 'run-metadata.json'), '{}\n');
  await writeFile(join(incompleteDirectory, 'run-metadata.json'), JSON.stringify({
    schemaVersion: 1,
    runId: 'incomplete-run',
    status: 'running',
  }));

  const store = new FilesystemArtifactStore({stateRoot: root});
  const runs = await store.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, FIXTURE_RUN_ID);
  assert.equal(runs[0].status, 'completed');
  assert.equal(runs[0].mode, 'sample');
  assert.equal(runs[0].matchCount, 146);
  assert.equal(runs[0].champion.species, 'Kyogre');
  assert.equal(runs[0].hasReport, true);
});

test('invalid and incomplete canonical runs return a safe validation error', async t => {
  for (const [name, mutate] of [
    ['invalid', async root => {
      await writeFile(
        join(root, 'runs', FIXTURE_RUN_ID, 'standings.json'),
        '{not-json',
        'utf8'
      );
    }],
    ['incomplete', async root => {
      const path = join(root, 'runs', FIXTURE_RUN_ID, 'run-metadata.json');
      const metadata = JSON.parse(await readFile(path, 'utf8'));
      metadata.status = 'running';
      metadata.completedAt = null;
      await writeFile(path, `${JSON.stringify(metadata)}\n`, 'utf8');
    }],
  ]) {
    await t.test(name, async t => {
      const root = await createFixtureRoot();
      t.after(() => removeFixtureRoot(root));
      await mutate(root);
      const store = new FilesystemArtifactStore({stateRoot: root});
      await assert.rejects(
        store.getRun(FIXTURE_RUN_ID),
        error => error instanceof ArtifactStoreError &&
          error.code === 'INVALID_RUN' && !error.message.includes(root)
      );
    });
  }
});

test('match pagination uses opaque query-bound cursors and enforces lookup', async t => {
  const root = await createFixtureRoot();
  t.after(() => removeFixtureRoot(root));
  const store = new FilesystemArtifactStore({stateRoot: root});

  const first = await store.listMatches(FIXTURE_RUN_ID, {limit: 2, query: 'blastoise'});
  assert.equal(first.items.length, 2);
  assert.ok(first.total > 2);
  assert.equal(first.items[0].stage, 'Group stage');
  assert.ok(first.nextCursor);
  const second = await store.listMatches(FIXTURE_RUN_ID, {
    cursor: first.nextCursor,
    limit: 2,
    query: 'blastoise',
  });
  assert.equal(second.items.length, 2);
  assert.notEqual(second.items[0].matchId, first.items[0].matchId);
  assert.throws(() => decodeCursor(first.nextCursor, {
    resource: 'matches', query: 'other-query', stage: '', result: '', hostname: '',
    sort: 'matchId', direction: 'asc',
  }), /cursor is invalid/i);

  const match = await store.getMatch(FIXTURE_RUN_ID, first.items[0].matchId);
  assert.equal(match.matchId, first.items[0].matchId);
  assert.ok(Array.isArray(match.seed));
  assert.match(match.protocolHash, /^[0-9a-f]{64}$/);
  await assert.rejects(
    store.getMatch(FIXTURE_RUN_ID, 'missing-match'),
    error => error.code === 'MATCH_NOT_FOUND'
  );
});

test('match filters and sorting are server-side and cursor-bound', async t => {
  const root = await createFixtureRoot();
  t.after(() => removeFixtureRoot(root));
  const store = new FilesystemArtifactStore({stateRoot: root});
  const hostname = 'metronome-simulator-558bdb896d-7nnm2';
  const page = await store.listMatches(FIXTURE_RUN_ID, {
    limit: 5,
    query: 'blastoise',
    stage: 'Group stage',
    result: 'win',
    hostname,
    sort: 'turns',
    direction: 'desc',
  });
  assert.ok(page.items.length > 1);
  assert.ok(page.items.every(item => item.stage === 'Group stage' &&
    item.outcome === 'win' && item.servedBy === hostname &&
    [item.matchId, item.pokemon1, item.pokemon2].some(value =>
      value.toLowerCase().includes('blastoise'))));
  assert.ok(page.items.every((item, index) => index === 0 ||
    page.items[index - 1].turns >= item.turns));
  assert.throws(() => decodeCursor(page.nextCursor, {
    resource: 'matches', query: 'blastoise', stage: 'Knockout', result: 'win',
    hostname, sort: 'turns', direction: 'desc',
  }), /cursor is invalid/i);
});

test('standings are searchable and paginated without returning every entrant', async t => {
  const root = await createFixtureRoot();
  t.after(() => removeFixtureRoot(root));
  const store = new FilesystemArtifactStore({stateRoot: root});
  const first = await store.getStandings(FIXTURE_RUN_ID, {
    group: 'A', query: '', limit: 2,
  });
  assert.equal(first.items.length, 2);
  assert.equal(first.groups.length, 4);
  assert.ok(first.nextCursor);
  assert.ok(first.items[0].tieKey);
  const searched = await store.getStandings(FIXTURE_RUN_ID, {
    group: 'A', query: 'blastoise', limit: 25,
  });
  assert.equal(searched.total, 1);
  assert.equal(searched.items[0].species, 'Blastoise');
});

test('run detail exposes renderer-aligned report projections', async t => {
  const root = await createFixtureRoot();
  t.after(() => removeFixtureRoot(root));
  const run = await new FilesystemArtifactStore({stateRoot: root}).getRun(FIXTURE_RUN_ID);
  assert.equal(run.report.integrity.verified, true);
  assert.equal(run.report.statistics.wins + run.report.statistics.draws, run.matchCount);
  assert.equal(run.report.podAttribution.totalAcceptedCount, run.matchCount);
  assert.deepEqual(run.report.sourceFiles, [
    'run-metadata.json', 'roster.json', 'results.jsonl', 'checkpoint.json',
    'standings.json', 'bracket.json',
  ]);
});

test('offline report is returned from the store as a download payload', async t => {
  const root = await createFixtureRoot();
  t.after(() => removeFixtureRoot(root));
  const store = new FilesystemArtifactStore({stateRoot: root});
  const report = await store.getReport(FIXTURE_RUN_ID);
  assert.equal(report.fileName, `${FIXTURE_RUN_ID}-report.html`);
  assert.equal(report.contentType, 'text/html; charset=utf-8');
  assert.equal(report.size, report.body.length);
  assert.match(report.body.toString('utf8', 0, 100), /^<!doctype html>/);
});

test('concurrent run views share one strict artifact load', async t => {
  const root = await createFixtureRoot();
  t.after(() => removeFixtureRoot(root));
  let loadCount = 0;
  const store = new FilesystemArtifactStore({
    stateRoot: root,
    async loadTournamentArtifacts(options) {
      loadCount++;
      return loadTournamentArtifacts(options);
    },
  });

  await Promise.all([
    store.getRun(FIXTURE_RUN_ID),
    store.getStandings(FIXTURE_RUN_ID),
    store.getBracket(FIXTURE_RUN_ID),
  ]);
  assert.equal(loadCount, 1);
});
