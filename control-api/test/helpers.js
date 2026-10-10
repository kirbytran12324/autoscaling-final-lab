'use strict';
const {ControlError} = require('../src/errors');

const config = {namespace: 'lab', image: 'runner:test', stateClaim: 'active', archiveClaim: 'archive',
  secretName: 'runner-status', simulatorUrl: 'http://simulator', rulesVersion: 'rules-v1',
  simulatorVersion: 'pokemon-showdown@0.11.11', statusPort: 3003,
  statusUrl: 'http://runner-status:3003', statusToken: 's'.repeat(32), maxConcurrency: 16};
const input = {runId: 'sample-one', mode: 'sample', seed: 'repeatable', concurrency: 2};

class FakeKube {
  constructor() { this.objects = new Map(); this.serial = 0; this.calls = []; }
  key(kind, name) { return `${kind}/${name}`; }
  async get(kind, name) { return structuredClone(this.objects.get(this.key(kind, name)) || null); }
  async list(kind, selector) {
    const [field, value] = selector.split('=');
    return {items: [...this.objects.entries()].filter(([key, item]) => key.startsWith(kind + '/') &&
      item.metadata.labels?.[field] === value).map(([, item]) => structuredClone(item))};
  }
  async create(kind, body) {
    const key = this.key(kind, body.metadata.name);
    if (this.objects.has(key)) throw new ControlError(409, 'KUBE_CONFLICT', 'Exists');
    const object = structuredClone(body);
    Object.assign(object.metadata, {uid: String(++this.serial), resourceVersion: String(this.serial)});
    this.objects.set(key, object); this.calls.push(['create', key]);
    return structuredClone(object);
  }
  async replace(kind, name, body) {
    const previous = await this.get(kind, name);
    if (previous.metadata.resourceVersion !== body.metadata.resourceVersion) throw new ControlError(409, 'KUBE_CONFLICT', 'Version conflict');
    const object = structuredClone(body);
    object.metadata.resourceVersion = String(++this.serial);
    this.objects.set(this.key(kind, name), object);
    return structuredClone(object);
  }
  async patch(kind, name, patch) {
    const previous = await this.get(kind, name);
    if (patch.metadata?.resourceVersion !== previous.metadata.resourceVersion) throw new ControlError(409, 'KUBE_CONFLICT', 'Version conflict');
    return this.replace(kind, name, {...previous, spec: {...previous.spec, ...patch.spec}});
  }
  async delete(kind, name, metadata) {
    const old = await this.get(kind, name);
    if (!old) return;
    if (old.metadata.uid !== metadata.uid || old.metadata.resourceVersion !== metadata.resourceVersion) throw new ControlError(409, 'KUBE_CONFLICT', 'Version conflict');
    this.objects.delete(this.key(kind, name)); this.calls.push(['delete', this.key(kind, name)]);
    if (kind === 'jobs') for (const pod of (await this.list('pods', `job-name=${name}`)).items) this.objects.delete(this.key('pods', pod.metadata.name));
  }
  async logs() { return 'Saved runner output'; }
  async condition(name, type) {
    const job = await this.get('jobs', name);
    job.status = {conditions: [{type, status: 'True'}]};
    return this.replace('jobs', name, job);
  }
}
module.exports = {FakeKube, config, input};
