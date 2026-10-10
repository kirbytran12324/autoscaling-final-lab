'use strict';
const {isDeepStrictEqual} = require('node:util');
const {ControlError} = require('./errors');
const {validateInput} = require('./config');
const {buildJob, jobName} = require('./jobs');

const SLOT = 'metronome-runner-slot';
const SELECTOR = 'app.kubernetes.io/managed-by=metronome-control';
const recordName = id => `mt-run-${id}`;
const decode = object => object ? JSON.parse(object.data.record) : null;
const terminal = (job, type) => job?.status?.conditions?.some(condition => condition.type === type && condition.status === 'True');

class RunManager {
  constructor(kube, config, {fetchImpl = fetch} = {}) {
    Object.assign(this, {kube, config, fetchImpl});
  }
  resource(name, record) {
    return {apiVersion: 'v1', kind: 'ConfigMap', metadata: {name, namespace: this.config.namespace,
      labels: {'app.kubernetes.io/managed-by': 'metronome-control', 'metronome.kind': 'record'}},
    data: {record: JSON.stringify(record)}};
  }
  async read(id) {
    const object = await this.kube.get('configmaps', recordName(id));
    if (!object) throw new ControlError(404, 'RUN_NOT_FOUND', 'Run was not found.');
    return {object, record: decode(object)};
  }
  async update(object, changes) {
    const next = {...decode(object), ...changes};
    return this.kube.replace('configmaps', object.metadata.name,
      {...object, data: {record: JSON.stringify(next)}});
  }
  async create(body) {
    const input = validateInput(body, this.config.maxConcurrency);
    const existing = await this.kube.get('configmaps', recordName(input.runId));
    if (existing) {
      if (!isDeepStrictEqual(decode(existing).input, input)) throw new ControlError(409, 'RUN_ID_CONFLICT', 'Run ID already has different settings.');
      return this.status(input.runId);
    }
    // Creation of this one name is the atomic admission operation, including
    // across API restarts. Its payload recovers a crash before registry creation.
    const record = {input, phase: 'pending', desired: 'running', publisherAttempt: 1,
      createdAt: new Date().toISOString(), config: {
        namespace: this.config.namespace, image: this.config.image,
        stateClaim: this.config.stateClaim, archiveClaim: this.config.archiveClaim,
        secretName: this.config.secretName, simulatorUrl: this.config.simulatorUrl,
        rulesVersion: this.config.rulesVersion, simulatorVersion: this.config.simulatorVersion,
        statusPort: this.config.statusPort,
      }};
    try { await this.kube.create('configmaps', this.resource(SLOT, record)); }
    catch (error) {
      if (error.status !== 409) throw error;
      const slot = decode(await this.kube.get('configmaps', SLOT));
      if (!slot || !isDeepStrictEqual(slot.input, input)) throw new ControlError(409, 'RUNNER_BUSY', 'Another tournament owns the runner.');
    }
    await this.reconcile();
    return this.status(input.runId);
  }
  async ensure(kind, name, body) {
    const existing = await this.kube.get(kind, name);
    if (existing) {
      if (existing.metadata.labels?.['app.kubernetes.io/managed-by'] !== 'metronome-control') {
        throw new ControlError(409, 'RESOURCE_CONFLICT', 'A resource with this name is not managed by the control service.');
      }
      return existing;
    }
    try { return await this.kube.create(kind, body); }
    catch (error) { if (error.status !== 409) throw error; return this.kube.get(kind, name); }
  }
  async pods(name) {
    return (await this.kube.list('pods', `job-name=${name}`)).items || [];
  }
  async drainedJob(name, job) {
    if (job) {
      // Foreground deletion releases completed Pod mounts before publishing.
      if (!job.metadata.deletionTimestamp) await this.kube.delete('jobs', name, job.metadata);
      return false;
    }
    return (await this.pods(name)).length === 0;
  }
  async release(slot) { await this.kube.delete('configmaps', SLOT, slot.metadata); }
  async logsFor(name) {
    const pods = await this.pods(name);
    const pod = pods.sort((a, b) => (b.metadata.creationTimestamp || '').localeCompare(a.metadata.creationTimestamp || ''))[0];
    if (!pod) return '';
    try { return await this.kube.logs(pod.metadata.name); }
    catch { return 'Logs are not available yet.'; }
  }
  async reconcile() {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.tick().finally(() => { this.reconciling = null; });
    return this.reconciling;
  }
  async tick() {
    const slot = await this.kube.get('configmaps', SLOT);
    if (!slot) return;
    const reserved = decode(slot);
    const id = reserved.input.runId;
    let object = await this.ensure('configmaps', recordName(id), this.resource(recordName(id), reserved));
    let record = decode(object);
    const set = async changes => { object = await this.update(object, changes); record = decode(object); };
    const runnerName = jobName(id);
    let runner = await this.kube.get('jobs', runnerName);
    if (record.phase === 'completed') {
      const pubName = jobName(id, 'publish', record.publisherAttempt);
      if (await this.drainedJob(pubName, await this.kube.get('jobs', pubName))) await this.release(slot);
      return;
    }
    if (record.desired === 'released') {
      if (await this.drainedJob(runnerName, runner)) await this.release(slot);
      return;
    }
    if (record.phase === 'failed' || record.phase === 'publication-failed') return;
    if (terminal(runner, 'Complete')) {
      await set({phase: 'publishing', runnerLogs: await this.logsFor(runnerName)});
    } else if (terminal(runner, 'Failed')) {
      await set({phase: 'failed', runnerLogs: await this.logsFor(runnerName),
        error: 'Runner Job failed. Inspect logs; persisted tournament failure and Pod failure may require different recovery.'});
      return;
    }
    if (record.phase === 'publishing') {
      if (!await this.drainedJob(runnerName, runner)) return;
      const pubName = jobName(id, 'publish', record.publisherAttempt);
      const publisher = await this.ensure('jobs', pubName,
        buildJob(record.input, record.config, 'publish', record.publisherAttempt));
      if (terminal(publisher, 'Complete')) {
        const publisherLogs = await this.logsFor(pubName);
        let progress = record.progress;
        for (const line of publisherLogs.split('\n')) {
          try {
            const result = JSON.parse(line.slice(line.indexOf('{')));
            if (result.runId === id && result.archived === true && result.checkpoint?.stage === 'complete' &&
                Number.isInteger(result.checkpoint.acceptedResultCount)) progress = result.checkpoint;
          } catch { /* regular output line */ }
        }
        await set({phase: 'completed', error: null, publisherLogs, ...(progress ? {progress} : {})});
      }
      else if (terminal(publisher, 'Failed')) await set({phase: 'publication-failed',
        publisherLogs: await this.logsFor(pubName), error: 'Tournament finished, but archive publication failed. Publication can be retried.'});
      return;
    }
    runner = await this.ensure('jobs', runnerName, buildJob(record.input, record.config));
    const suspended = record.desired === 'paused';
    if (Boolean(runner.spec.suspend) !== suspended) await this.kube.patch('jobs', runnerName,
      {metadata: {resourceVersion: runner.metadata.resourceVersion}, spec: {suspend: suspended}});
    const pods = await this.pods(runnerName);
    const active = pods.some(p => !['Succeeded', 'Failed'].includes(p.status?.phase));
    let phase = suspended ? (active ? 'pausing' : 'paused') : (active ? 'running' : 'pending');
    const snapshot = await this.snapshot(id);
    if (!suspended && snapshot?.stopping) phase = 'resuming';
    const progress = snapshot?.checkpoint || record.progress;
    if (record.phase !== phase || !isDeepStrictEqual(record.progress, progress)) await set({phase, ...(progress ? {progress} : {})});
  }
  async snapshot(id) {
    try {
      const response = await this.fetchImpl(new URL('/status', this.config.statusUrl), {
        headers: {authorization: `Bearer ${this.config.statusToken}`}, signal: AbortSignal.timeout(3000)});
      if (!response.ok) return null;
      const value = await response.json();
      return value.runId === id ? value : null;
    } catch { return null; }
  }
  async status(id) {
    validateInput({runId: id, mode: 'sample', seed: 'check', concurrency: 1}, this.config.maxConcurrency);
    const {record} = await this.read(id);
    const live = ['running', 'pausing', 'resuming'].includes(record.phase) ? await this.snapshot(id) : null;
    return {...record.input, phase: record.phase, createdAt: record.createdAt,
      error: record.error || null, jobName: jobName(id), progress: live?.checkpoint || record.progress || null,
      snapshot: live, archiveReady: record.phase === 'completed'};
  }
  async list() {
    const objects = (await this.kube.list('configmaps', SELECTOR)).items || [];
    return objects.filter(object => object.metadata.name.startsWith('mt-run-'))
      .map(object => { const record = decode(object); return {...record.input, phase: record.phase,
        createdAt: record.createdAt, archiveReady: record.phase === 'completed'}; })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async action(id, action) {
    const slot = await this.kube.get('configmaps', SLOT);
    if (decode(slot)?.input.runId !== id) throw new ControlError(409, 'RUN_NOT_ACTIVE', 'This run does not own the runner.');
    const {object, record} = await this.read(id);
    if (['pause', 'resume'].includes(action)) {
      if (!['pending', 'running', 'pausing', 'paused', 'resuming'].includes(record.phase)) {
        throw new ControlError(409, 'INVALID_TRANSITION', 'Only an unfinished tournament can be paused or resumed.');
      }
      await this.update(object, {desired: action === 'pause' ? 'paused' : 'running'});
    } else if (action === 'retry-publication') {
      if (record.phase !== 'publication-failed') throw new ControlError(409, 'INVALID_TRANSITION', 'Publication has not failed.');
      const name = jobName(id, 'publish', record.publisherAttempt);
      if (!await this.drainedJob(name, await this.kube.get('jobs', name))) {
        throw new ControlError(409, 'PUBLICATION_DRAINING', 'Previous publisher is being removed. Retry after its Pods terminate.');
      }
      await this.update(object, {phase: 'publishing', publisherAttempt: record.publisherAttempt + 1, error: null});
    } else if (action === 'release-failed') {
      if (record.phase !== 'failed') throw new ControlError(409, 'INVALID_TRANSITION', 'Only a failed runner can release its slot.');
      await this.update(object, {desired: 'released'});
    } else throw new ControlError(404, 'NOT_FOUND', 'Unknown run action.');
    await this.reconcile();
    return this.status(id);
  }
  async logs(id) {
    const {record} = await this.read(id);
    const publisher = ['publishing', 'publication-failed', 'completed'].includes(record.phase);
    const current = await this.logsFor(publisher ? jobName(id, 'publish', record.publisherAttempt) : jobName(id));
    return {logs: [record.runnerLogs || '', publisher ? record.publisherLogs || '' : '', current].filter(Boolean).join('\n')};
  }
}

module.exports = {RunManager, SLOT, recordName};
