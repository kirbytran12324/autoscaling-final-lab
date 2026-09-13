'use strict';

const assert = require('node:assert/strict');
const {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {after, before, test} = require('node:test');

const {generateReport, atomicWriteText} = require('../src/report');
const {parseReportConfiguration, runCli} = require('../src/report-cli');
const {loadAutoscalingEvidence, loadRestartEvidence} = require('../src/report-evidence');
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

function restartSummary(overrides = {}) {
  return {
    result: 'job-completed',
    run_id: RUN_ID,
    interruption_stage: 'groups',
    interruption_threshold: '10',
    first_pod: 'runner-original',
    first_pod_uid: 'original-uid',
    replacement_pod: 'runner-replacement',
    replacement_pod_uid: 'replacement-uid',
    pvc_preserved: 'true',
    job_preserved: 'true',
    ...overrides,
  };
}

function restartCheckpoint(overrides = {}) {
  return {
    schemaVersion: 1,
    stage: 'groups',
    round: null,
    schedulePosition: 10,
    acceptedResultCount: 10,
    updatedAt: '2026-09-11T08:15:00.000Z',
    ...overrides,
  };
}

async function writeRestartEvidence(directory, summary, checkpoint) {
  await writeFile(
    join(directory, 'summary.txt'),
    `${Object.entries(summary).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
    'utf8'
  );
  await writeFile(
    join(directory, 'checkpoint-before-interruption.json'),
    JSON.stringify(checkpoint),
    'utf8'
  );
}

async function writePhase7Evidence(directory, overrides = {}) {
  const experimentId = 'phase7-test';
  const captureStatus = {
    schemaVersion: '1',
    experimentId,
    status: 'complete',
    sampleCount: 40,
    successfulSampleCount: 40,
    failedSampleCount: 0,
    finalValidation: 'ok',
    finalArtifactCollection: 'ok',
    observations: {
      maximumDesiredReplicas: 6,
      maximumReadyReplicas: 6,
      finalReplicaCount: 1,
      finalDesiredReplicas: 1,
      experimentAcceptanceEvaluated: false,
    },
    ...overrides.captureStatus,
  };
  const metadata = {
    schemaVersion: '1',
    experimentId,
    inputs: {
      captureDurationSeconds: 600,
      sampleIntervalSeconds: 15,
      evidenceLocustUsers: 3,
      evidenceLocustSpawnRate: 1,
      evidenceLocustRunSeconds: 180,
    },
    simulator: {
      deployment: {
        resourceSettings: {
          requests: {cpu: '500m', memory: '192Mi'},
          limits: {cpu: '1', memory: '256Mi'},
        },
      },
      hpa: {startingConfiguration: {
        scaleTargetRef: {kind: 'Deployment', name: 'metronome-simulator'},
        minReplicas: 1,
        maxReplicas: 6,
        metrics: [{
          type: 'Resource',
          resource: {
            name: 'cpu',
            target: {type: 'Utilization', averageUtilization: 70},
          },
        }],
        behavior: {
          scaleUp: {stabilizationWindowSeconds: 0},
          scaleDown: {stabilizationWindowSeconds: 150},
        },
      }},
    },
    locust: {
      runtime: {podUid: 'locust-uid', containerId: 'containerd://locust', restartCount: 0},
    },
    ...overrides.metadata,
  };
  const timestamps = Array.from({length: 40}, (_, index) =>
    new Date(Date.parse('2026-09-13T15:51:26Z') + index * 15_000).toISOString()
  );
  const desired = timestamps.map((_, index) => {
    if (index < 4) return 1;
    if (index === 4) return 2;
    if (index < 7) return 3;
    if (index < 10) return 5;
    if (index < 25) return 6;
    if (index === 25) return 4;
    return 1;
  });
  const hpaRows = timestamps.map((timestamp, index) =>
    `${timestamp},70,350m,70,${desired[index]},${desired[index]},ReadyForNewScale`
  );
  const replicaRows = timestamps.map((timestamp, index) =>
    `${timestamp},${desired[index]},${desired[index]},${desired[index]},` +
    `${desired[index]},${desired[index]},0`
  );
  const sampleRows = timestamps.map((timestamp, index) =>
    `${timestamp},${timestamp},${timestamp},${index + 1},ok,ok,ok,ok,ok,ok`
  );
  const podNames = Array.from({length: 6}, (_, index) => `simulator-pod-${index + 1}`);
  const podRows = podNames.map(pod =>
    `2026-09-13T15:53:56Z,${pod},uid-${pod},worker,Running,,false,True,true,0,` +
    `simulator:test,simulator:test,sha256:test,containerd://${pod},500m,180Mi`
  );
  const endpointRows = podNames.map((pod, index) =>
    `2026-09-13T15:53:56Z,slice,10.0.0.${index + 1},${pod},true,true,false`
  );
  const distribution = podNames.map((pod, index) =>
    `${pod}=${index === 0 ? 3 : 2}`
  ).join(', ');
  const locust = {
    start_time: '2026-09-13T15:51:30Z',
    end_time: '2026-09-13T15:54:30Z',
    requests_statistics: [{
      name: 'Aggregated',
      num_requests: 13,
      num_failures: 0,
      total_rps: 72.42,
      avg_response_time: 41.02,
      median_response_time: 33,
      'response_time_percentile_0.95': 95,
      'response_time_percentile_0.99': 160,
      max_response_time: 949,
    }],
    history: [{
      time: '2026-09-13T15:53:00Z',
      current_rps: ['2026-09-13T15:53:00Z', 75],
      'response_time_percentile_0.95': ['2026-09-13T15:53:00Z', 95],
      current_fail_per_sec: ['2026-09-13T15:53:00Z', 0],
    }],
  };
  const files = {
    'capture-status.json': `${JSON.stringify(captureStatus)}\n`,
    'metadata.json': `${JSON.stringify(metadata)}\n`,
    'hpa.csv': [
      'timestamp,current_cpu_utilization,current_cpu_average_value,target_cpu_utilization,current_replicas,desired_replicas,condition_reasons',
      ...hpaRows,
      '',
    ].join('\n'),
    'replicas.csv': [
      'timestamp,desired_replicas,current_replicas,updated_replicas,available_replicas,ready_replicas,unavailable_replicas',
      ...replicaRows,
      '',
    ].join('\n'),
    'pods.csv': [
      'timestamp,pod_name,pod_uid,node,phase,deletion_timestamp,terminating,pod_ready,container_ready,restart_count,declared_image,runtime_image,runtime_image_id,container_id,cpu,memory',
      ...podRows,
      '',
    ].join('\n'),
    'endpoints.csv': [
      'timestamp,endpointslice_name,address,target_pod,ready,serving,terminating',
      ...endpointRows,
      '',
    ].join('\n'),
    'sample-status.csv': [
      'scheduled_at,sample_started_at,sample_completed_at,sample_number,status,hpa,deployment,pods,pod_metrics,endpointslices',
      ...sampleRows,
      '',
    ].join('\n'),
    'locust.log': `servedBy distribution: ${distribution}\n`,
    'locust_report.html': `<script>window.templateArgs = ${JSON.stringify(locust)}\n` +
      `window.theme = "dark"</script>`,
  };
  await Promise.all(Object.entries(files).map(([name, contents]) =>
    writeFile(join(directory, name), contents, 'utf8')
  ));
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
  assert.match(html, /Run summary/);
  assert.match(html, /Group standings/);
  assert.match(html, /Knockout bracket and series/);
  assert.match(html, /Simulation explorer/);
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
  assert.ok(!(await readdir(runDirectory)).some(name =>
    name.startsWith('.report.html.')
  ));
});

test('atomic writer preserves an old report if rename fails', async t => {
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
    await assert.rejects(
      generateReport({stateRoot, runId: RUN_ID}),
      /run ID conflict/i
    );
  });

  await t.test('incomplete', async t => {
    const stateRoot = await createFixtureRoot();
    t.after(() => rm(stateRoot, {recursive: true, force: true}));
    const path = join(stateRoot, 'runs', RUN_ID, 'run-metadata.json');
    const metadata = await json(path);
    metadata.status = 'running';
    metadata.completedAt = null;
    await writeFile(path, `${JSON.stringify(metadata)}\n`, 'utf8');
    await assert.rejects(
      generateReport({stateRoot, runId: RUN_ID}),
      /tournament is incomplete/i
    );
  });
});

test('absent optional evidence renders explicit placeholders', async t => {
  const stateRoot = await createFixtureRoot();
  t.after(() => rm(stateRoot, {recursive: true, force: true}));
  const {outputPath} = await generateReport({
    stateRoot,
    runId: RUN_ID,
    now: () => GENERATED_AT,
  });
  const html = await readFile(outputPath, 'utf8');
  assert.match(html, /Restart\/resume evidence not supplied\./);
  assert.match(html, /Phase 7 HPA evidence was not supplied/);
  assert.doesNotMatch(html, /id="autoscaling-chart"/);
});

test('supplied current restart evidence is rendered without inferred Pod data', async t => {
  const stateRoot = await createFixtureRoot();
  const evidence = await mkdtemp(join(tmpdir(), 'restart-evidence-'));
  t.after(() => Promise.all([
    rm(stateRoot, {recursive: true, force: true}),
    rm(evidence, {recursive: true, force: true}),
  ]));
  await writeRestartEvidence(
    evidence,
    restartSummary(),
    restartCheckpoint()
  );
  const {outputPath} = await generateReport({
    stateRoot,
    runId: RUN_ID,
    restartEvidenceDirectory: evidence,
    now: () => GENERATED_AT,
  });
  const html = await readFile(outputPath, 'utf8');
  assert.match(html, /runner-original/);
  assert.match(html, /runner-replacement/);
  assert.match(html, /Duplicate accepted match IDs<\/span><strong>0/);
});

test('restart evidence rejects malformed checkpoints', async t => {
  const evidence = await mkdtemp(join(tmpdir(), 'restart-invalid-checkpoint-'));
  t.after(() => rm(evidence, {recursive: true, force: true}));
  await writeRestartEvidence(evidence, restartSummary(), []);
  const result = await loadRestartEvidence(evidence, RUN_ID, {
    duplicateMatchIdCount: 0,
    uniqueResultCount: 144,
  });
  assert.equal(result.status, 'incompatible');
  assert.match(result.reason, /checkpoint evidence is invalid.*non-array object/i);
});

test('restart evidence rejects a failed harness status', async t => {
  const evidence = await mkdtemp(join(tmpdir(), 'restart-failed-status-'));
  t.after(() => rm(evidence, {recursive: true, force: true}));
  await writeRestartEvidence(
    evidence,
    restartSummary({result: 'job-failed'}),
    restartCheckpoint()
  );
  const result = await loadRestartEvidence(evidence, RUN_ID, {});
  assert.equal(result.status, 'incompatible');
  assert.match(result.reason, /not job-completed/i);
});

test('restart evidence rejects identical original and replacement identities', async t => {
  for (const [description, overrides, pattern] of [
    [
      'Pod names',
      {replacement_pod: 'runner-original'},
      /Pod names must differ/i,
    ],
    [
      'Pod UIDs',
      {replacement_pod_uid: 'original-uid'},
      /Pod UIDs must differ/i,
    ],
  ]) {
    await t.test(description, async t => {
      const evidence = await mkdtemp(join(tmpdir(), 'restart-same-identity-'));
      t.after(() => rm(evidence, {recursive: true, force: true}));
      await writeRestartEvidence(
        evidence,
        restartSummary(overrides),
        restartCheckpoint()
      );
      const result = await loadRestartEvidence(evidence, RUN_ID, {});
      assert.equal(result.status, 'incompatible');
      assert.match(result.reason, pattern);
    });
  }
});

test('restart evidence rejects inconsistent interruption counts', async t => {
  const evidence = await mkdtemp(join(tmpdir(), 'restart-counts-'));
  t.after(() => rm(evidence, {recursive: true, force: true}));
  await writeRestartEvidence(
    evidence,
    restartSummary({interruption_threshold: '11'}),
    restartCheckpoint({acceptedResultCount: 10})
  );
  const result = await loadRestartEvidence(evidence, RUN_ID, {});
  assert.equal(result.status, 'incompatible');
  assert.match(result.reason, /below the interruption threshold/i);
});

test('restart evidence rejects non-preserved Job and PVC values', async t => {
  for (const [field, pattern] of [
    ['pvc_preserved', /PVC was preserved/i],
    ['job_preserved', /Job was preserved/i],
  ]) {
    await t.test(field, async t => {
      const evidence = await mkdtemp(join(tmpdir(), 'restart-not-preserved-'));
      t.after(() => rm(evidence, {recursive: true, force: true}));
      await writeRestartEvidence(
        evidence,
        restartSummary({[field]: 'false'}),
        restartCheckpoint()
      );
      const result = await loadRestartEvidence(evidence, RUN_ID, {});
      assert.equal(result.status, 'incompatible');
      assert.match(result.reason, pattern);
    });
  }
});

test('compatible autoscaling evidence renders an offline aligned chart', async t => {
  const stateRoot = await createFixtureRoot();
  const evidence = await mkdtemp(join(tmpdir(), 'autoscaling-evidence-'));
  t.after(() => Promise.all([
    rm(stateRoot, {recursive: true, force: true}),
    rm(evidence, {recursive: true, force: true}),
  ]));
  await writeFile(join(evidence, 'autoscaling-timeline.csv'), [
    'timestamp,ready_replicas,request_rate,p95_latency_ms,failures',
    '2026-09-11T08:00:00Z,1,10,850,2',
    '2026-09-11T08:01:00Z,3,28,310,0',
    '',
  ].join('\n'), 'utf8');
  const {outputPath} = await generateReport({
    stateRoot,
    runId: RUN_ID,
    autoscalingEvidenceDirectory: evidence,
    now: () => GENERATED_AT,
  });
  const html = await readFile(outputPath, 'utf8');
  assert.match(html, /id="autoscaling-chart"/);
  assert.match(html, /ready_replicas|"replicas":1/);
  assert.doesNotMatch(html, /Pending Phase 7/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(html, /index\*\(1160\/\(rows\.length-1\|\|1\)\)/);
  assert.doesNotMatch(html, /Math\.max\(1,1160/);
});

test('complete Phase 7 recorder evidence renders validated HPA acceptance', async t => {
  const stateRoot = await createFixtureRoot();
  const evidence = await mkdtemp(join(tmpdir(), 'phase7-evidence-'));
  t.after(() => Promise.all([
    rm(stateRoot, {recursive: true, force: true}),
    rm(evidence, {recursive: true, force: true}),
  ]));
  await writePhase7Evidence(evidence);

  const loaded = await loadAutoscalingEvidence(evidence);
  assert.equal(loaded.status, 'supplied');
  assert.equal(loaded.verdict, 'PASS');
  assert.deepEqual(
    loaded.transitions.map(row => row.desiredReplicas),
    [1, 2, 3, 5, 6, 4, 1]
  );
  assert.equal(loaded.locust.requests, 13);
  assert.equal(loaded.distribution.length, 6);

  const {outputPath} = await generateReport({
    stateRoot,
    runId: RUN_ID,
    autoscalingEvidenceDirectory: evidence,
    now: () => GENERATED_AT,
  });
  const html = await readFile(outputPath, 'utf8');
  assert.match(html, /Phase 7 HPA experiment: PASS/);
  assert.match(html, /1 → 2 → 3 → 5 → 6 → 4 → 1/);
  assert.match(html, /72\.42/);
  assert.match(html, /simulator-pod-6/);
  assert.match(html, /approximately 350m per Pod/);
  assert.match(html, /192Mi request \/ 256Mi limit/);
  assert.match(html, /id="autoscaling-chart"/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('incomplete or conflicting Phase 7 recorder evidence is incompatible', async t => {
  await t.test('missing required artifact', async t => {
    const evidence = await mkdtemp(join(tmpdir(), 'phase7-incomplete-'));
    t.after(() => rm(evidence, {recursive: true, force: true}));
    await writePhase7Evidence(evidence);
    await rm(join(evidence, 'endpoints.csv'));
    const loaded = await loadAutoscalingEvidence(evidence);
    assert.equal(loaded.status, 'incompatible');
    assert.match(loaded.reason, /endpoints\.csv is missing/);
  });

  await t.test('servedBy total mismatch', async t => {
    const evidence = await mkdtemp(join(tmpdir(), 'phase7-conflict-'));
    t.after(() => rm(evidence, {recursive: true, force: true}));
    await writePhase7Evidence(evidence);
    const logPath = join(evidence, 'locust.log');
    const log = await readFile(logPath, 'utf8');
    await writeFile(logPath, log.replace('simulator-pod-1=3', 'simulator-pod-1=4'));
    const loaded = await loadAutoscalingEvidence(evidence);
    assert.equal(loaded.status, 'incompatible');
    assert.match(loaded.reason, /request total does not reconcile/);
  });

  await t.test('non-accepted HPA configuration', async t => {
    const evidence = await mkdtemp(join(tmpdir(), 'phase7-wrong-config-'));
    t.after(() => rm(evidence, {recursive: true, force: true}));
    await writePhase7Evidence(evidence);
    const metadataPath = join(evidence, 'metadata.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    metadata.simulator.hpa.startingConfiguration.behavior.scaleDown
      .stabilizationWindowSeconds = 300;
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
    const loaded = await loadAutoscalingEvidence(evidence);
    assert.equal(loaded.status, 'incompatible');
    assert.match(loaded.reason, /HPA configuration is incompatible/);
  });
});

test('HTML escapes artifact strings, embeds no external resources, and bounds rows', async t => {
  const stateRoot = await createFixtureRoot();
  t.after(() => rm(stateRoot, {recursive: true, force: true}));
  const {outputPath} = await generateReport({
    stateRoot,
    runId: RUN_ID,
    now: () => GENERATED_AT,
  });
  const html = await readFile(outputPath, 'utf8');
  assert.doesNotMatch(html, /<img src=x onerror=alert/);
  assert.match(html, /&lt;\/script&gt;&lt;img/);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)\s*=\s*["']https?:/i);
  assert.doesNotMatch(html, /@import\s+url/i);
  assert.match(html, /const pageSize=100/);
  assert.match(html, /filtered\.slice\(start,start\+pageSize\)/);
  assert.equal((html.match(/<tbody>/g) || []).length < 100, true);
});

test('generation is substantively deterministic with a controlled timestamp', async t => {
  const stateRoot = await createFixtureRoot();
  t.after(() => rm(stateRoot, {recursive: true, force: true}));
  const first = join(stateRoot, 'first.html');
  const second = join(stateRoot, 'second.html');
  await generateReport({stateRoot, runId: RUN_ID, outputPath: first, now: () => GENERATED_AT});
  await generateReport({stateRoot, runId: RUN_ID, outputPath: second, now: () => GENERATED_AT});
  assert.equal(await readFile(first, 'utf8'), await readFile(second, 'utf8'));
});

test('report CLI exposes only the required run location contract', async () => {
  assert.deepEqual(parseReportConfiguration({
    TOURNAMENT_STATE_ROOT: '/state',
    TOURNAMENT_RUN_ID: 'sample-32-001',
  }), {
    stateRoot: '/state',
    runId: 'sample-32-001',
    restartEvidenceDirectory: undefined,
    autoscalingEvidenceDirectory: undefined,
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
      assert.equal(options.runId, 'sample-32-001');
      return {acceptedResultCount: 144, outputPath: '/state/runs/sample-32-001/report.html'};
    },
  });
  assert.equal(exitCode, 0);
  assert.match(output[0], /report\.html/);
});
