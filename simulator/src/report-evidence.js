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

async function loadAutoscalingEvidence(directory) {
  if (directory === undefined) return {status: 'absent'};
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

module.exports = {
  loadAutoscalingEvidence,
  loadRestartEvidence,
  parseCsv,
};
