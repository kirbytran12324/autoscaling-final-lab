'use strict';

const assert = require('node:assert/strict');
const {cp, mkdtemp, readFile, readdir, rm, writeFile} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {after, before, test} = require('node:test');
const vm = require('node:vm');

const {atomicWriteText, generateReport} = require('../src/report');
const {parseReportConfiguration, runCli} = require('../src/report-cli');
const {loadTournamentArtifacts} = require('../src/report-loader');
const {
  aggregatePodAttribution,
  deriveSharedHostnamePrefix,
  formatDuration,
  formatNumber,
  PAGE_SIZE_OPTIONS,
  paginateRows,
  paginateStandings,
  renderPodAttribution,
  renderReport,
  roundCounts,
} = require('../src/report-renderer');
const {runTournament} = require('../src/runner');

const RUN_ID = 'completed-report-fixture';
const GENERATED_AT = '2026-09-11T09:00:00.000Z';
let baselineRoot;

function identity() {
  return {
    runId: RUN_ID,
    mode: 'sample',
    tournamentSeed: 'report-seed</script><img src=x onerror=alert(1)>',
    rulesVersion: 'metronome-singles-v1',
    simulatorVersion: 'pokemon-showdown@0.11.11',
    simulatorImage: 'metronome-simulator:test<&>',
    runnerConcurrency: 4,
  };
}

function responseFor(request, callNumber) {
  return {
    matchId: request.matchId,
    pokemon1: request.pokemon1,
    pokemon2: request.pokemon2,
    seed: [...request.seed],
    simulatorVersion: identity().simulatorVersion,
    outcome: 'win',
    winnerSide: 'p1',
    winnerSpecies: request.pokemon1,
    turns: (callNumber % 99) + 1,
    termination: 'natural',
    protocolHash: (callNumber % 16).toString(16).repeat(64),
    servedBy: callNumber % 2 === 0 ? 'pod-a<&>' : 'pod-b',
    durationMs: callNumber + 0.25,
  };
}

async function createFixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), 'report-test-'));
  await cp(join(baselineRoot, 'runs'), join(root, 'runs'), {recursive: true});
  return root;
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function fixtureArtifacts() {
  return loadTournamentArtifacts({stateRoot: baselineRoot, runId: RUN_ID});
}

before(async () => {
  baselineRoot = await mkdtemp(join(tmpdir(), 'report-baseline-'));
  let callNumber = 0;
  await runTournament({
    stateRoot: baselineRoot,
    identity: identity(),
    now: () => '2026-09-11T08:00:00.000Z',
    async runBattle(request) {
      callNumber++;
      return responseFor(request, callNumber);
    },
  });
});

after(async () => {
  await rm(baselineRoot, {recursive: true, force: true});
});

test('completed-run report generation uses the default output location', async t => {
  const stateRoot = await createFixtureRoot();
  t.after(() => rm(stateRoot, {recursive: true, force: true}));
  const summary = await generateReport({
    stateRoot,
    runId: RUN_ID,
    now: () => GENERATED_AT,
  });
  const expectedPath = join(stateRoot, 'runs', RUN_ID, 'report.html');
  assert.equal(summary.outputPath, expectedPath);
  assert.equal(summary.acceptedResultCount, 157);
  assert.equal(summary.duplicateMatchIdCount, 0);
  const html = await readFile(expectedPath, 'utf8');
  assert.match(html, /Tournament outcome/);
  assert.match(html, /Group standings/);
  assert.match(html, /Knockout rounds/);
  assert.match(html, /Battle explorer/);
  assert.match(html, /Accepted battles by reported simulator Pod/);
  assert.match(html, /completed-report-fixture/);
});

test('regeneration atomically replaces report.html and leaves no temporary file', async t => {
  const stateRoot = await createFixtureRoot();
  t.after(() => rm(stateRoot, {recursive: true, force: true}));
  const runDirectory = join(stateRoot, 'runs', RUN_ID);
  const outputPath = join(runDirectory, 'report.html');
  await writeFile(outputPath, 'old partial report', 'utf8');
  await generateReport({stateRoot, runId: RUN_ID, now: () => GENERATED_AT});
  assert.match(await readFile(outputPath, 'utf8'), /^<!doctype html>/);
  assert.ok(!(await readdir(runDirectory)).some(name => name.startsWith('.report.html.')));
});

test('atomic writer preserves an old report and cleans up if rename fails', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'report-atomic-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, 'report.html');
  await writeFile(path, 'old report', 'utf8');
  await assert.rejects(
    atomicWriteText(path, 'new report', {
      async rename() { throw new Error('rename interrupted'); },
    }),
    /rename interrupted/
  );
  assert.equal(await readFile(path, 'utf8'), 'old report');
  assert.deepEqual(await readdir(directory), ['report.html']);
});

test('missing and malformed required artifacts are rejected', async t => {
  for (const [name, mutate, pattern] of [
    ['missing', path => rm(path), /required.*standings\.json.*missing/i],
    ['malformed', path => writeFile(path, '{oops', 'utf8'), /malformed.*standings\.json/i],
  ]) {
    await t.test(name, async t => {
      const stateRoot = await createFixtureRoot();
      t.after(() => rm(stateRoot, {recursive: true, force: true}));
      await mutate(join(stateRoot, 'runs', RUN_ID, 'standings.json'));
      await assert.rejects(generateReport({stateRoot, runId: RUN_ID}), pattern);
    });
  }
});

test('run-ID conflicts and incomplete runs are rejected', async t => {
  await t.test('run ID conflict', async t => {
    const stateRoot = await createFixtureRoot();
    t.after(() => rm(stateRoot, {recursive: true, force: true}));
    const path = join(stateRoot, 'runs', RUN_ID, 'run-metadata.json');
    const metadata = await json(path);
    metadata.runId = 'different-run';
    await writeFile(path, `${JSON.stringify(metadata)}\n`, 'utf8');
    await assert.rejects(generateReport({stateRoot, runId: RUN_ID}), /run ID conflict/i);
  });

  await t.test('incomplete', async t => {
    const stateRoot = await createFixtureRoot();
    t.after(() => rm(stateRoot, {recursive: true, force: true}));
    const path = join(stateRoot, 'runs', RUN_ID, 'run-metadata.json');
    const metadata = await json(path);
    metadata.status = 'running';
    metadata.completedAt = null;
    await writeFile(path, `${JSON.stringify(metadata)}\n`, 'utf8');
    await assert.rejects(generateReport({stateRoot, runId: RUN_ID}), /tournament is incomplete/i);
  });
});

test('Pod attribution aggregates arbitrary hostnames and stages deterministically', () => {
  const attribution = aggregatePodAttribution([
    {servedBy: 'worker-z', stage: 'qualifier'},
    {servedBy: 'worker-a', stage: 'finals'},
    {servedBy: 'worker-z', stage: 'unexpected-stage'},
    {servedBy: 'worker-a', stage: 'qualifier'},
    {servedBy: 'worker-b', stage: 'qualifier'},
    {servedBy: 'worker-z', stage: 'qualifier'},
    {servedBy: 'worker-b', stage: 'finals'},
  ]);
  assert.equal(attribution.totalAcceptedCount, 7);
  assert.equal(attribution.attributedCount, 7);
  assert.equal(attribution.distinctHostnameCount, 3);
  assert.deepEqual(attribution.rows.map(row => row.fullHostname), [
    'worker-z',
    'worker-a',
    'worker-b',
  ]);
  assert.deepEqual(attribution.rows.map(row => row.sharedPrefix), [
    'worker-',
    'worker-',
    'worker-',
  ]);
  assert.deepEqual(attribution.rows.map(row => row.distinguishingPart), ['z', 'a', 'b']);
  assert.deepEqual(attribution.rows.map(row => row.acceptedCount), [3, 2, 2]);
  assert.deepEqual(attribution.stages, [
    {stage: 'qualifier', count: 4},
    {stage: 'finals', count: 2},
    {stage: 'unexpected-stage', count: 1},
  ]);
  assert.ok(Math.abs(
    attribution.rows.reduce((total, row) => total + row.acceptedShare, 0) - 100
  ) < 1e-9);
});

test('hostname comparison derives a useful prefix without assuming a suffix length', () => {
  const hostnames = [
    'metronome-simulator-558bdb896d-c5pl7',
    'metronome-simulator-558bdb896d-4qmrc',
    'metronome-simulator-558bdb896d-q7gt9',
  ];
  assert.equal(
    deriveSharedHostnamePrefix(hostnames),
    'metronome-simulator-558bdb896d-'
  );
  assert.equal(deriveSharedHostnamePrefix(['alpha', 'zulu']), '');
  assert.equal(deriveSharedHostnamePrefix(['only-host']), '');
});

test('Pod attribution handles one hostname and missing attribution or stage', () => {
  const single = aggregatePodAttribution([
    {servedBy: 'only-host', stage: 'round-one'},
    {servedBy: 'only-host'},
  ]);
  assert.equal(single.distinctHostnameCount, 1);
  assert.equal(single.rows[0].acceptedShare, 100);
  assert.equal(single.rows[0].sharedPrefix, '');
  assert.equal(single.rows[0].distinguishingPart, 'only-host');
  assert.deepEqual(single.rows[0].stageCounts, {'round-one': 1, Unspecified: 1});

  const missing = aggregatePodAttribution([
    {servedBy: '', stage: 'round-one'},
    {stage: 'round-two'},
    {servedBy: '  ', stage: 'round-three'},
  ]);
  assert.equal(missing.totalAcceptedCount, 3);
  assert.equal(missing.attributedCount, 0);
  assert.equal(missing.unattributedCount, 3);
  assert.equal(missing.distinctHostnameCount, 0);
  assert.deepEqual(missing.rows, []);
});

test('Pod attribution uses a compact breakdown for many discovered stages', async () => {
  const artifacts = await fixtureArtifacts();
  const stages = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const data = {
    ...artifacts,
    results: artifacts.results.slice(0, stages.length).map((result, index) => ({
      ...result,
      servedBy: `host-${index % 2}`,
      stage: stages[index],
    })),
  };
  const html = renderPodAttribution(data);
  assert.match(html, /<th>Stage breakdown<\/th>/);
  for (const stage of stages) assert.match(html, new RegExp(`${stage}: 1`));
});

test('Pod attribution section is omitted when no hostname is usable', async () => {
  const artifacts = await fixtureArtifacts();
  const html = renderReport({
    ...artifacts,
    results: artifacts.results.map(result => ({...result, servedBy: ''})),
  }, {generatedAt: GENERATED_AT});
  assert.doesNotMatch(html, /id="pod-attribution"/);
  assert.doesNotMatch(html, /href="#pod-attribution"/);
});

test('standings pagination supports filtering, empty results, and partial pages', () => {
  const group = {
    standings: Array.from({length: 123}, (_, index) => ({
      rank: index + 1,
      species: index === 122 ? 'Needlemon' : `Species ${index + 1}`,
    })),
  };
  const first = paginateStandings(group, '', 0);
  const second = paginateStandings(group, '', 1);
  const last = paginateStandings(group, '', 4);
  assert.equal(first.entries.length, 25);
  assert.equal(second.entries.length, 25);
  assert.equal(last.entries.length, 23);
  assert.equal(last.pageCount, 5);
  assert.equal(paginateStandings(group, 'needle', 2).page, 0);
  assert.equal(paginateStandings(group, 'needle', 0).entries[0].species, 'Needlemon');
  const empty = paginateStandings(group, 'missing', 10);
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.page, 0);
  assert.equal(empty.pageCount, 1);
  assert.deepEqual(PAGE_SIZE_OPTIONS, [25, 50, 100]);
  assert.equal(paginateRows(group.standings, 1, 50).entries.length, 50);
  assert.equal(paginateRows(group.standings, 1, 100).entries.length, 23);
  assert.equal(paginateRows(group.standings, 99, 17).pageSize, 25);
});

test('generated group and round tabs derive their accessible state from artifacts', async () => {
  const artifacts = await fixtureArtifacts();
  const html = renderReport(artifacts, {generatedAt: GENERATED_AT});
  assert.equal((html.match(/data-group-index="\d+"[^>]*role="tab"/g) || []).length, 0);
  assert.equal((html.match(/role="tab"[^>]*data-group-index="\d+"/g) || []).length, 4);
  assert.equal((html.match(/role="tab"[^>]*data-round-index="\d+"/g) || []).length, 4);
  assert.match(html, /role="tablist" aria-label="Tournament groups"/);
  assert.match(html, /role="tablist" aria-label="Knockout rounds"/);
  assert.match(html, /aria-selected="true" aria-controls="standings-panel-0" tabindex="0"/);
  assert.match(html, /aria-selected="false" aria-controls="round-panel-1" tabindex="-1"/);
  assert.match(html, /advances/);
  assert.match(html, /Game outcome \/ game winner/);
  const counts = artifacts.bracket.rounds.map(roundCounts);
  assert.deepEqual(counts.map(item => item.series), [8, 4, 2, 1]);
  assert.equal(counts.reduce((total, item) => total + item.games, 0),
    artifacts.results.length - artifacts.expectedGroupResultCount);
});

test('number and duration formatting are readable and deterministic', () => {
  assert.equal(formatNumber(130969), '130,969');
  assert.equal(formatNumber(1025), '1,025');
  assert.equal(formatDuration(12), '12 ms');
  assert.equal(formatDuration(12_500), '12.50 s');
  assert.equal(formatDuration(200 * 60_000 + 20_222), '3h 20m 20s');
});

test('report uses corrected interpretation wording and excludes experiment panels', async () => {
  const artifacts = await fixtureArtifacts();
  const html = renderReport(artifacts, {generatedAt: GENERATED_AT});
  assert.match(html, /Wall-clock span/);
  assert.match(html, /not active runner execution time/);
  assert.match(html, /Terminal battle failures/);
  assert.match(html, /bounded concurrent completion order/);
  assert.doesNotMatch(html, /Restart\/resume|autoscaling-chart|Phase 7 HPA|Phase 8|Phase 9|Phase 10/);
});

test('report hierarchy and reusable table controls keep secondary evidence collapsed', async () => {
  const artifacts = await fixtureArtifacts();
  const html = renderReport(artifacts, {generatedAt: GENERATED_AT});
  const headline = html.match(
    /<div class="metric-grid headline-metrics">([\s\S]*?)<\/div><\/section>/
  )[1];
  assert.equal((headline.match(/class="metric"/g) || []).length, 5);
  assert.match(html, /class="verified-banner/);
  assert.match(html, /<summary>Verification details<\/summary>/);
  assert.match(html, /<section id="details"/);
  assert.match(html, /<summary>Configuration and timing<\/summary>/);
  assert.match(html, /id="standings-page-size"/);
  assert.match(html, /id="sim-page-size"/);
  for (const size of PAGE_SIZE_OPTIONS) {
    assert.match(html, new RegExp(`<option value="${size}"`));
  }
  assert.match(html, /class="data-table primary-sticky/);
  assert.match(html, /id="sim-reset"/);
  assert.match(html, /id="sim-detail"/);
  assert.match(html, /aria-current/);
  assert.match(html, /class="back-top"/);
  assert.match(html, /data-copy=/);
  assert.match(html, /class="pod-hostname"/);
  assert.match(html, /class="hostname-prefix"/);
  assert.match(html, /class="hostname-distinguishing"/);
  assert.match(html, /class="chart-hostname"/);
  assert.match(html, /--sticky-nav-height/);
  assert.match(html, /ResizeObserver/);
});

test('HTML escapes strings, embeds no external resources, and bounds rendered rows', async () => {
  const artifacts = await fixtureArtifacts();
  const html = renderReport(artifacts, {generatedAt: GENERATED_AT});
  assert.doesNotMatch(html, /<img src=x onerror=alert/);
  assert.match(html, /&lt;\/script&gt;&lt;img/);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)\s*=\s*["']https?:/i);
  assert.doesNotMatch(html, /@import\s+url/i);
  assert.match(html, /defaultSize:25/);
  assert.match(html, /filtered\.slice\(start,start\+simPager\.pageSize\)/);
  assert.ok((html.match(/<tr/g) || []).length < 180);

  const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
  assert.doesNotThrow(() => new vm.Script(scripts.at(-1)[1]));
  const payload = JSON.parse(
    html.match(/<script id="simulation-data" type="application\/json">([\s\S]*?)<\/script>/)[1]
  );
  assert.equal(payload.rows.length, artifacts.results.length);
  assert.equal(payload.rows[0].length, payload.columns.length);
});

test('generation differs only at explicitly labelled timestamps', async t => {
  const stateRoot = await createFixtureRoot();
  t.after(() => rm(stateRoot, {recursive: true, force: true}));
  const first = join(stateRoot, 'first.html');
  const second = join(stateRoot, 'second.html');
  const later = '2026-09-11T10:00:00.000Z';
  await generateReport({stateRoot, runId: RUN_ID, outputPath: first, now: () => GENERATED_AT});
  await generateReport({stateRoot, runId: RUN_ID, outputPath: second, now: () => later});
  const firstHtml = await readFile(first, 'utf8');
  const secondHtml = await readFile(second, 'utf8');
  assert.equal((firstHtml.match(new RegExp(GENERATED_AT, 'g')) || []).length, 2);
  assert.equal((secondHtml.match(new RegExp(later, 'g')) || []).length, 2);
  assert.equal(firstHtml.replaceAll(GENERATED_AT, '<generated-at>'),
    secondHtml.replaceAll(later, '<generated-at>'));
});

test('report CLI exposes only the required run location contract', async () => {
  assert.deepEqual(parseReportConfiguration({
    TOURNAMENT_STATE_ROOT: '/state',
    TOURNAMENT_RUN_ID: 'sample-32-001',
  }), {
    stateRoot: '/state',
    runId: 'sample-32-001',
  });
  const output = [];
  const exitCode = await runCli({
    env: {
      TOURNAMENT_STATE_ROOT: '/state',
      TOURNAMENT_RUN_ID: 'sample-32-001',
    },
    args: [],
    stdout: message => output.push(message),
    stderr: () => assert.fail('successful report CLI must not write stderr'),
    async generateReportImpl(options) {
      assert.deepEqual(options, {stateRoot: '/state', runId: 'sample-32-001'});
      return {acceptedResultCount: 144, outputPath: '/state/runs/sample-32-001/report.html'};
    },
  });
  assert.equal(exitCode, 0);
  assert.match(output[0], /report\.html/);
});
