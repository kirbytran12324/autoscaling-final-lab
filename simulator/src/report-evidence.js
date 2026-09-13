'use strict';

const {readFile} = require('node:fs/promises');
const {join} = require('node:path');
const {validateCheckpoint} = require('./runner-state');

function parseKeyValue(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) {
      values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return values;
}

async function optionalRead(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function loadRestartEvidence(directory, runId, integrity) {
  if (directory === undefined) {
    return {status: 'absent'};
  }

  const summaryText = await optionalRead(join(directory, 'summary.txt'));
  const checkpointText = await optionalRead(
    join(directory, 'checkpoint-before-interruption.json')
  );
  if (summaryText === undefined || checkpointText === undefined) {
    return {status: 'incompatible', reason: 'current harness evidence is incomplete'};
  }

  const summary = parseKeyValue(summaryText);
  let checkpoint;
  try {
    checkpoint = JSON.parse(checkpointText);
  } catch (error) {
    return {status: 'incompatible', reason: `checkpoint evidence is malformed: ${error.message}`};
  }

  if (summary.result !== 'job-completed') {
    return {
      status: 'incompatible',
      reason: 'restart harness result is not job-completed',
    };
  }

  if (summary.run_id !== runId) {
    return {status: 'incompatible', reason: 'evidence run ID does not match this report'};
  }

  try {
    validateCheckpoint(checkpoint);
  } catch (error) {
    return {
      status: 'incompatible',
      reason: `checkpoint evidence is invalid: ${error.message}`,
    };
  }

  if (checkpoint.stage !== 'groups' || checkpoint.round !== null ||
      summary.interruption_stage !== 'groups') {
    return {
      status: 'incompatible',
      reason: 'restart interruption checkpoint must represent the group stage',
    };
  }

  if (checkpoint.acceptedResultCount <= 0) {
    return {
      status: 'incompatible',
      reason: 'checkpoint accepted-result count must be a positive integer',
    };
  }

  if (!/^[1-9][0-9]*$/.test(summary.interruption_threshold || '') ||
      !Number.isSafeInteger(Number(summary.interruption_threshold))) {
    return {
      status: 'incompatible',
      reason: 'interruption threshold must be a positive integer',
    };
  }

  const interruptionThreshold = Number(summary.interruption_threshold);
  if (checkpoint.acceptedResultCount < interruptionThreshold) {
    return {
      status: 'incompatible',
      reason: 'checkpoint accepted-result count is below the interruption threshold',
    };
  }

  for (const field of [
    'first_pod',
    'first_pod_uid',
    'replacement_pod',
    'replacement_pod_uid',
  ]) {
    if (typeof summary[field] !== 'string' || summary[field] === '') {
      return {status: 'incompatible', reason: `summary.txt is missing ${field}`};
    }
  }

  if (summary.first_pod === summary.replacement_pod) {
    return {
      status: 'incompatible',
      reason: 'original and replacement Pod names must differ',
    };
  }

  if (summary.first_pod_uid === summary.replacement_pod_uid) {
    return {
      status: 'incompatible',
      reason: 'original and replacement Pod UIDs must differ',
    };
  }

  if (summary.pvc_preserved !== 'true') {
    return {
      status: 'incompatible',
      reason: 'restart evidence does not confirm that the PVC was preserved',
    };
  }

  if (summary.job_preserved !== 'true') {
    return {
      status: 'incompatible',
      reason: 'restart evidence does not confirm that the Job was preserved',
    };
  }

  return {
    status: 'supplied',
    result: summary.result,
    interruptionStage: summary.interruption_stage,
    interruptionThreshold,
    checkpoint,
    firstPod: summary.first_pod,
    firstPodUid: summary.first_pod_uid,
    replacementPod: summary.replacement_pod,
    replacementPodUid: summary.replacement_pod_uid,
    finalStatus: summary.result,
    duplicateMatchIdCount: integrity.duplicateMatchIdCount,
    uniqueResultCount: integrity.uniqueResultCount,
  };
}

function parseCsv(contents) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < contents.length; index++) {
    const character = contents[index];
    if (quoted) {
      if (character === '"' && contents[index + 1] === '"') {
        field += '"';
        index++;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new SyntaxError('CSV has an unterminated quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    if (row.some(value => value !== '')) rows.push(row);
  }
  return rows;
}

function findHeader(headers, patterns) {
  return headers.findIndex(header => patterns.some(pattern => pattern.test(header)));
}

function csvRecords(contents, fileName) {
  const parsed = parseCsv(contents);
  if (parsed.length < 2) {
    throw new Error(`${fileName} has no observations`);
  }
  const headers = parsed[0];
  if (new Set(headers).size !== headers.length) {
    throw new Error(`${fileName} has duplicate headers`);
  }
  return parsed.slice(1).map((values, index) => {
    if (values.length !== headers.length) {
      throw new Error(`${fileName} row ${index + 2} has the wrong number of fields`);
    }
    return Object.fromEntries(headers.map((header, field) => [header, values[field]]));
  });
}

function finiteNumber(value, description) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${description} is not numeric`);
  return number;
}

function requireTimestamp(value, description) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${description} is not a valid timestamp`);
  }
  return value;
}

function parseJson(contents, fileName) {
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`${fileName} is malformed: ${error.message}`);
  }
}

function parseLocustReport(contents) {
  const match = contents.match(
    /window\.templateArgs\s*=\s*(\{.*\})\s*\n\s*window\.theme/s
  );
  if (match === null) throw new Error('locust_report.html has no embedded report data');
  return parseJson(match[1], 'locust_report.html embedded report data');
}

function parseServedBy(contents) {
  const lines = contents.split(/\r?\n/)
    .filter(line => line.includes('servedBy distribution:'));
  if (lines.length === 0) throw new Error('Locust log has no servedBy distribution');
  const distribution = lines.at(-1).split('servedBy distribution:')[1].trim();
  if (distribution === '' || distribution === '(none)') {
    throw new Error('Locust servedBy distribution is empty');
  }

  const counts = [];
  for (const entry of distribution.split(/,\s*/)) {
    const separator = entry.lastIndexOf('=');
    const pod = entry.slice(0, separator).trim();
    const count = Number(entry.slice(separator + 1));
    if (separator <= 0 || pod === '' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('Locust servedBy distribution is malformed');
    }
    counts.push({pod, count});
  }
  if (new Set(counts.map(entry => entry.pod)).size !== counts.length) {
    throw new Error('Locust servedBy distribution contains duplicate Pods');
  }
  return counts.sort((left, right) => left.pod.localeCompare(right.pod));
}

function desiredTransitions(hpaRows, replicaRows) {
  const transitions = [];
  let previous;
  for (const row of hpaRows) {
    const desired = finiteNumber(row.desired_replicas, 'hpa.csv desired_replicas');
    if (desired === previous) continue;
    const observed = replicaRows.find(replica =>
      Date.parse(replica.timestamp) >= Date.parse(row.timestamp)
    );
    transitions.push({
      timestamp: requireTimestamp(row.timestamp, 'hpa.csv timestamp'),
      desiredReplicas: desired,
      readyReplicas: observed === undefined
        ? null
        : finiteNumber(observed.ready_replicas, 'replicas.csv ready_replicas'),
    });
    previous = desired;
  }
  return transitions;
}

function alignPhase7Timeline(replicaRows, history, startTime, endTime) {
  return replicaRows.map(replica => {
    const timestamp = requireTimestamp(replica.timestamp, 'replicas.csv timestamp');
    const time = Date.parse(timestamp);
    const current = time < Date.parse(startTime) || time > Date.parse(endTime)
      ? undefined
      : history.filter(item => Date.parse(item.time) <= time).at(-1);
    return {
      timestamp,
      replicas: finiteNumber(replica.ready_replicas, 'replicas.csv ready_replicas'),
      requestRate: current === undefined
        ? 0
        : finiteNumber(current.current_rps?.[1], 'Locust history request rate'),
      latency: current === undefined
        ? 0
        : finiteNumber(
          current['response_time_percentile_0.95']?.[1],
          'Locust history p95 latency'
        ),
      failures: current === undefined
        ? 0
        : finiteNumber(current.current_fail_per_sec?.[1], 'Locust history failures'),
    };
  });
}

async function loadPhase7AutoscalingEvidence(directory, firstFiles) {
  const requiredFiles = [
    'capture-status.json',
    'metadata.json',
    'hpa.csv',
    'replicas.csv',
    'pods.csv',
    'endpoints.csv',
    'sample-status.csv',
    'locust.log',
    'locust_report.html',
  ];
  const contents = {...firstFiles};
  for (const fileName of requiredFiles) {
    if (contents[fileName] === undefined) {
      contents[fileName] = await optionalRead(join(directory, fileName));
    }
    if (contents[fileName] === undefined) {
      throw new Error(`Phase 7 evidence is incomplete: ${fileName} is missing`);
    }
  }

  const captureStatus = parseJson(contents['capture-status.json'], 'capture-status.json');
  const metadata = parseJson(contents['metadata.json'], 'metadata.json');
  const inputs = metadata.inputs;
  const hpaRows = csvRecords(contents['hpa.csv'], 'hpa.csv');
  const replicaRows = csvRecords(contents['replicas.csv'], 'replicas.csv');
  const podRows = csvRecords(contents['pods.csv'], 'pods.csv');
  const endpointRows = csvRecords(contents['endpoints.csv'], 'endpoints.csv');
  const sampleRows = csvRecords(contents['sample-status.csv'], 'sample-status.csv');
  const locust = parseLocustReport(contents['locust_report.html']);
  const distribution = parseServedBy(contents['locust.log']);

  if (captureStatus.schemaVersion !== '1' || metadata.schemaVersion !== '1') {
    throw new Error('Phase 7 evidence schema version is not supported');
  }
  if (captureStatus.experimentId !== metadata.experimentId) {
    throw new Error('Phase 7 experiment IDs do not match');
  }
  if (captureStatus.status !== 'complete' || captureStatus.failedSampleCount !== 0 ||
      captureStatus.finalValidation !== 'ok' ||
      captureStatus.finalArtifactCollection !== 'ok') {
    throw new Error('Phase 7 capture did not complete with valid configuration and artifacts');
  }
  if (captureStatus.observations?.experimentAcceptanceEvaluated !== false) {
    throw new Error('Phase 7 capture does not preserve independent acceptance evaluation');
  }
  const expectedSampleCount = inputs?.captureDurationSeconds /
    inputs?.sampleIntervalSeconds;
  if (!Number.isSafeInteger(expectedSampleCount) ||
      sampleRows.length !== expectedSampleCount ||
      sampleRows.length !== captureStatus.sampleCount ||
      sampleRows.length !== captureStatus.successfulSampleCount ||
      hpaRows.length !== sampleRows.length || replicaRows.length !== sampleRows.length) {
    throw new Error('Phase 7 sample counts do not reconcile');
  }
  const requiredSampleFields = [
    'status',
    'hpa',
    'deployment',
    'pods',
    'pod_metrics',
    'endpointslices',
  ];
  if (sampleRows.some(row => requiredSampleFields.some(field => row[field] !== 'ok'))) {
    throw new Error('Phase 7 evidence contains a failed required sample');
  }

  const firstReplica = replicaRows[0];
  const finalReplica = replicaRows.at(-1);
  const desiredValues = replicaRows.map(row =>
    finiteNumber(row.desired_replicas, 'replicas.csv desired_replicas')
  );
  const readyValues = replicaRows.map(row =>
    finiteNumber(row.ready_replicas, 'replicas.csv ready_replicas')
  );
  const maximumDesiredReplicas = Math.max(...desiredValues);
  const maximumReadyReplicas = Math.max(...readyValues);
  if (finiteNumber(firstReplica.desired_replicas, 'initial desired replicas') !== 1 ||
      finiteNumber(firstReplica.ready_replicas, 'initial Ready replicas') !== 1 ||
      finiteNumber(finalReplica.desired_replicas, 'final desired replicas') !== 1 ||
      finiteNumber(finalReplica.ready_replicas, 'final Ready replicas') !== 1 ||
      maximumDesiredReplicas !== 6 || maximumReadyReplicas !== 6) {
    throw new Error('Phase 7 replica timeline does not show scale-out and return to one');
  }
  if (maximumDesiredReplicas !== captureStatus.observations?.maximumDesiredReplicas ||
      maximumReadyReplicas !== captureStatus.observations?.maximumReadyReplicas ||
      Number(finalReplica.ready_replicas) !== captureStatus.observations?.finalReplicaCount ||
      Number(finalReplica.desired_replicas) !== captureStatus.observations?.finalDesiredReplicas) {
    throw new Error('Phase 7 replica observations conflict with capture-status.json');
  }

  const hpa = metadata.simulator?.hpa?.startingConfiguration;
  const cpuMetric = hpa?.metrics?.find(metric =>
    metric.type === 'Resource' && metric.resource?.name === 'cpu'
  );
  const resourceSettings = metadata.simulator?.deployment?.resourceSettings;
  if (hpa?.scaleTargetRef?.kind !== 'Deployment' ||
      hpa.scaleTargetRef.name !== 'metronome-simulator' ||
      hpa.minReplicas !== 1 || hpa.maxReplicas !== 6 ||
      cpuMetric?.resource?.target?.type !== 'Utilization' ||
      cpuMetric.resource.target.averageUtilization !== 70 ||
      hpa.behavior?.scaleUp?.stabilizationWindowSeconds !== 0 ||
      hpa.behavior?.scaleDown?.stabilizationWindowSeconds !== 150 ||
      resourceSettings?.requests?.cpu !== '500m' ||
      !['1', '1000m'].includes(resourceSettings?.limits?.cpu) ||
      resourceSettings?.requests?.memory !== '192Mi' ||
      resourceSettings?.limits?.memory !== '256Mi' ||
      inputs?.captureDurationSeconds !== 600 ||
      inputs?.sampleIntervalSeconds !== 15 ||
      inputs?.evidenceLocustUsers !== 3 ||
      inputs?.evidenceLocustSpawnRate !== 1 ||
      inputs?.evidenceLocustRunSeconds !== 180) {
    throw new Error('Phase 7 HPA configuration is incompatible');
  }
  if (metadata.locust?.runtime?.restartCount !== 0 ||
      metadata.locust?.runtime?.podUid === undefined ||
      metadata.locust?.runtime?.containerId === undefined) {
    throw new Error('Phase 7 Locust runtime identity is incomplete');
  }
  if (podRows.some(row => finiteNumber(row.restart_count, 'pods.csv restart_count') !== 0)) {
    throw new Error('Phase 7 simulator Pod restarted during the experiment');
  }

  const aggregate = locust.requests_statistics?.find(row => row.name === 'Aggregated');
  if (aggregate === undefined || !Array.isArray(locust.history) || locust.history.length === 0) {
    throw new Error('Locust report has no aggregate statistics or history');
  }
  requireTimestamp(locust.start_time, 'Locust start_time');
  requireTimestamp(locust.end_time, 'Locust end_time');
  const requests = finiteNumber(aggregate.num_requests, 'Locust request count');
  const failures = finiteNumber(aggregate.num_failures, 'Locust failure count');
  const servedTotal = distribution.reduce((total, entry) => total + entry.count, 0);
  if (servedTotal !== requests) {
    throw new Error('Locust request total does not reconcile with servedBy counts');
  }
  if (failures !== 0) throw new Error('Phase 7 Locust report contains failures');

  const podNames = new Set(podRows.map(row => row.pod_name));
  const readyEndpointPods = new Set(endpointRows
    .filter(row => row.ready === 'true')
    .map(row => row.target_pod));
  if (distribution.length !== maximumReadyReplicas || distribution.some(entry =>
    !podNames.has(entry.pod) || !readyEndpointPods.has(entry.pod)
  )) {
    throw new Error(
      'servedBy Pods do not reconcile with the maximum Ready replica set and timelines'
    );
  }

  const transitions = desiredTransitions(hpaRows, replicaRows);
  const readyMaximum = replicaRows.find(row =>
    Number(row.ready_replicas) === maximumReadyReplicas
  );
  const firstScaleIn = transitions.find(transition =>
    Date.parse(transition.timestamp) > Date.parse(locust.end_time) &&
    transition.desiredReplicas < maximumDesiredReplicas
  );
  const returnedToMinimum = replicaRows.find(row =>
    Date.parse(row.timestamp) > Date.parse(locust.end_time) &&
    Number(row.ready_replicas) === 1
  );
  if (readyMaximum === undefined || firstScaleIn === undefined ||
      returnedToMinimum === undefined) {
    throw new Error('Phase 7 timing milestones are incomplete');
  }

  const cpuRequest = resourceSettings.requests.cpu;
  const cpuLimit = resourceSettings.limits.cpu;
  const memoryRequest = resourceSettings.requests.memory;
  const memoryLimit = resourceSettings.limits.memory;
  const targetUtilization = cpuMetric.resource.target.averageUtilization;
  const cpuRequestMillicores = typeof cpuRequest === 'string' && /^\d+m$/.test(cpuRequest)
    ? Number(cpuRequest.slice(0, -1))
    : null;

  return {
    status: 'supplied',
    format: 'phase7-recorder-v1',
    source: 'Phase 7 recorder and Locust report',
    verdict: 'PASS',
    experimentId: metadata.experimentId,
    configuration: {
      captureDurationSeconds: metadata.inputs?.captureDurationSeconds,
      sampleIntervalSeconds: metadata.inputs?.sampleIntervalSeconds,
      locustUsers: metadata.inputs?.evidenceLocustUsers,
      locustSpawnRate: metadata.inputs?.evidenceLocustSpawnRate,
      locustRunSeconds: metadata.inputs?.evidenceLocustRunSeconds,
      cpuRequest,
      cpuLimit,
      memoryRequest,
      memoryLimit,
      targetUtilization,
      effectiveTargetMillicores: cpuRequestMillicores === null
        ? null
        : cpuRequestMillicores * targetUtilization / 100,
      minReplicas: hpa.minReplicas,
      maxReplicas: hpa.maxReplicas,
      scaleUpStabilizationSeconds: hpa.behavior?.scaleUp?.stabilizationWindowSeconds,
      scaleDownStabilizationSeconds: hpa.behavior.scaleDown.stabilizationWindowSeconds,
    },
    integrity: {
      sampleCount: captureStatus.sampleCount,
      successfulSampleCount: captureStatus.successfulSampleCount,
      failedSampleCount: captureStatus.failedSampleCount,
      finalValidation: captureStatus.finalValidation,
      finalArtifactCollection: captureStatus.finalArtifactCollection,
      maximumDesiredReplicas,
      maximumReadyReplicas,
      finalDesiredReplicas: Number(finalReplica.desired_replicas),
      finalReadyReplicas: Number(finalReplica.ready_replicas),
      simulatorRestarts: 0,
      acceptanceEvaluatedByRecorder: false,
    },
    timing: {
      loadStartedAt: locust.start_time,
      maximumReadyAt: readyMaximum.timestamp,
      scaleOutSeconds: Math.round(
        (Date.parse(readyMaximum.timestamp) - Date.parse(locust.start_time)) / 1000
      ),
      loadStoppedAt: locust.end_time,
      firstScaleInAt: firstScaleIn.timestamp,
      firstScaleInSeconds: Math.round(
        (Date.parse(firstScaleIn.timestamp) - Date.parse(locust.end_time)) / 1000
      ),
      returnedToMinimumAt: returnedToMinimum.timestamp,
      returnToMinimumSeconds: Math.round(
        (Date.parse(returnedToMinimum.timestamp) - Date.parse(locust.end_time)) / 1000
      ),
    },
    locust: {
      requests,
      failures,
      failureRate: requests === 0 ? 0 : failures / requests,
      averageRps: finiteNumber(aggregate.total_rps, 'Locust average RPS'),
      averageResponseTimeMs: finiteNumber(
        aggregate.avg_response_time,
        'Locust average response time'
      ),
      medianResponseTimeMs: finiteNumber(
        aggregate.median_response_time,
        'Locust median response time'
      ),
      p95ResponseTimeMs: finiteNumber(
        aggregate['response_time_percentile_0.95'],
        'Locust p95 response time'
      ),
      p99ResponseTimeMs: finiteNumber(
        aggregate['response_time_percentile_0.99'],
        'Locust p99 response time'
      ),
      maximumResponseTimeMs: finiteNumber(
        aggregate.max_response_time,
        'Locust maximum response time'
      ),
    },
    transitions,
    distribution,
    rows: alignPhase7Timeline(
      replicaRows,
      locust.history,
      locust.start_time,
      locust.end_time
    ),
  };
}

async function loadLegacyAutoscalingEvidence(directory) {
  const path = join(directory, 'autoscaling-timeline.csv');
  const contents = await optionalRead(path);
  if (contents === undefined) return {status: 'absent'};

  let parsed;
  try {
    parsed = parseCsv(contents);
  } catch (error) {
    return {status: 'incompatible', reason: error.message};
  }
  if (parsed.length < 2) {
    return {status: 'incompatible', reason: 'autoscaling-timeline.csv has no observations'};
  }

  const headers = parsed[0].map(header => header.trim().toLowerCase());
  const indexes = {
    timestamp: findHeader(headers, [/timestamp/, /^time$/]),
    replicas: findHeader(headers, [/ready.*replica/, /^replicas?$/, /current.*replica/]),
    requestRate: findHeader(headers, [/request.*rate/, /requests.*sec/, /^rps$/]),
    latency: findHeader(headers, [/p95.*latency/, /latency.*p95/, /^p95$/]),
    failures: findHeader(headers, [/failure/, /error.*rate/]),
  };
  if (Object.values(indexes).some(index => index < 0)) {
    return {
      status: 'incompatible',
      reason: 'timeline must include timestamp, replicas, request rate, p95 latency, and failures',
    };
  }

  const rows = [];
  for (const [rowIndex, values] of parsed.slice(1).entries()) {
    const row = {timestamp: values[indexes.timestamp]};
    for (const field of ['replicas', 'requestRate', 'latency', 'failures']) {
      const value = Number(values[indexes[field]]);
      if (!Number.isFinite(value)) {
        return {status: 'incompatible', reason: `timeline row ${rowIndex + 2} has invalid ${field}`};
      }
      row[field] = value;
    }
    rows.push(row);
  }
  return {status: 'supplied', source: 'autoscaling-timeline.csv', rows};
}

async function loadAutoscalingEvidence(directory) {
  if (directory === undefined) return {status: 'absent'};
  const firstFiles = {
    'capture-status.json': await optionalRead(join(directory, 'capture-status.json')),
    'metadata.json': await optionalRead(join(directory, 'metadata.json')),
  };
  if (Object.values(firstFiles).some(contents => contents !== undefined)) {
    try {
      return await loadPhase7AutoscalingEvidence(directory, firstFiles);
    } catch (error) {
      return {status: 'incompatible', reason: error.message};
    }
  }
  return loadLegacyAutoscalingEvidence(directory);
}

module.exports = {
  loadAutoscalingEvidence,
  loadRestartEvidence,
  parseCsv,
};
