'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {RunManager, SLOT, recordName} = require('../src/manager');
const {jobName, buildJob} = require('../src/jobs');
const {validateInput} = require('../src/config');
const {FakeKube, config, input} = require('./helpers');
const offline = {fetchImpl: async () => { throw new Error('Runner unavailable'); }};

test('input rejects capabilities, paths, extreme concurrency, and malformed settings', () => {
  for (const changed of [{runId: '../escape'}, {mode: 'other'}, {seed: ' '}, {seed: 'x\n'},
    {concurrency: 0}, {concurrency: 17}, {concurrency: 1.5}, {image: 'attacker:image'}, {command: 'shell'}]) {
    assert.throws(() => validateInput({...input, ...changed}), /Provide a DNS/);
  }
});

test('Job holds one writer, immutable configured image, hardened container, and no Kubernetes token', () => {
  const job = buildJob(input, config);
  assert.equal(job.spec.parallelism, 1);
  assert.equal(job.spec.suspend, true);
  assert.equal(job.spec.template.spec.automountServiceAccountToken, false);
  assert.deepEqual(job.spec.template.spec.containers[0].command, ['node']);
  assert.equal(job.spec.template.spec.containers[0].image, config.image);
  assert.equal(job.spec.template.spec.containers[0].env.find(e => e.name === 'RUNNER_STATUS_TOKEN').valueFrom.secretKeyRef.name, config.secretName);
  const publish = buildJob(input, config, 'publish');
  assert.equal(publish.spec.template.spec.volumes[0].persistentVolumeClaim.readOnly, true);
  assert.equal(publish.spec.template.spec.containers[0].env.some(e => e.name === 'RUNNER_STATUS_TOKEN'), false);
});

test('simultaneous different runs admit only one Job, duplicate requests are idempotent', async () => {
  const kube = new FakeKube();
  const a = new RunManager(kube, config, offline), b = new RunManager(kube, config, offline);
  const result = await Promise.allSettled([a.create(input), b.create({...input, runId: 'second'})]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(result.filter(r => r.status === 'rejected')[0].reason.code, 'RUNNER_BUSY');
  assert.equal(kube.calls.filter(([verb, key]) => verb === 'create' && key.startsWith('jobs/')).length, 1);
  assert.equal((await a.create(input)).runId, input.runId);
  await assert.rejects(a.create({...input, seed: 'different'}), {code: 'RUN_ID_CONFLICT'});
});

test('restart between reservation and registry recovers frozen configuration', async () => {
  const kube = new FakeKube();
  const original = new RunManager(kube, config, offline);
  await original.create(input);
  const registry = await kube.get('configmaps', recordName(input.runId));
  await kube.delete('configmaps', registry.metadata.name, registry.metadata);
  const job = await kube.get('jobs', jobName(input.runId));
  await kube.delete('jobs', job.metadata.name, job.metadata);
  await new RunManager(kube, {...config, image: 'later:image'}, offline).reconcile();
  assert.equal((await kube.get('jobs', jobName(input.runId))).spec.template.spec.containers[0].image, config.image);
});

test('pause holds reservation, resume keeps identity, unfinished Pods prevent premature paused state', async () => {
  const kube = new FakeKube(); const manager = new RunManager(kube, config, offline);
  await manager.create(input);
  const pod = await kube.create('pods', {metadata: {name: 'runner-pod', labels: {'job-name': jobName(input.runId)}}, status: {phase: 'Running'}});
  assert.equal((await manager.action(input.runId, 'pause')).phase, 'pausing');
  await kube.delete('pods', pod.metadata.name, pod.metadata);
  await manager.reconcile();
  assert.equal((await manager.status(input.runId)).phase, 'paused');
  await assert.rejects(manager.create({...input, runId: 'second'}), {code: 'RUNNER_BUSY'});
  await manager.action(input.runId, 'resume');
  const job = await kube.get('jobs', jobName(input.runId));
  assert.equal(job.spec.suspend, false);
  assert.equal(job.spec.template.spec.containers[0].env.find(e => e.name === 'TOURNAMENT_SEED').value, input.seed);
});

test('publisher follows runner removal, failure retries only publication, slot released after publisher removal', async () => {
  const kube = new FakeKube(); let manager = new RunManager(kube, config, offline);
  await manager.create(input);
  await kube.condition(jobName(input.runId), 'Complete');
  await manager.reconcile();
  assert.equal((await manager.status(input.runId)).phase, 'publishing');
  assert.equal(await kube.get('jobs', jobName(input.runId, 'publish')), null);
  manager = new RunManager(kube, config, offline);
  await manager.reconcile();
  await kube.condition(jobName(input.runId, 'publish'), 'Failed');
  await manager.reconcile();
  assert.equal((await manager.status(input.runId)).phase, 'publication-failed');
  await assert.rejects(manager.action(input.runId, 'retry-publication'), {code: 'PUBLICATION_DRAINING'});
  await manager.action(input.runId, 'retry-publication');
  await kube.condition(jobName(input.runId, 'publish', 2), 'Complete');
  await manager.reconcile();
  assert.equal((await manager.status(input.runId)).archiveReady, true);
  assert.ok(await kube.get('configmaps', SLOT));
  await manager.reconcile(); await manager.reconcile();
  assert.equal(await kube.get('configmaps', SLOT), null);
  assert.ok(await kube.get('configmaps', recordName(input.runId)));
  assert.equal(kube.calls.filter(([verb, key]) => verb === 'create' && key === 'jobs/' + jobName(input.runId)).length, 1);
});

test('failed Job stays failed, explicit release preserves registry and opens next run', async () => {
  const kube = new FakeKube(); const manager = new RunManager(kube, config, offline);
  await manager.create(input); await kube.condition(jobName(input.runId), 'Failed'); await manager.reconcile();
  await assert.rejects(manager.action(input.runId, 'resume'), {code: 'INVALID_TRANSITION'});
  await manager.action(input.runId, 'release-failed'); await manager.reconcile();
  assert.equal(await kube.get('configmaps', SLOT), null);
  assert.equal((await manager.status(input.runId)).phase, 'failed');
  assert.equal((await manager.create({...input, runId: 'next'})).runId, 'next');
});

test('status rejects stale snapshot for a different tournament and never discloses tokens/config', async () => {
  const kube = new FakeKube();
  const manager = new RunManager(kube, config, {fetchImpl: async () => new Response(JSON.stringify({runId: 'another', checkpoint: {acceptedResultCount: 99}}))});
  await manager.create(input);
  const status = await manager.status(input.runId);
  assert.equal(status.snapshot, null);
  assert.equal(status.config, undefined);
  assert.equal(JSON.stringify(status).includes(config.statusToken), false);
});

test('slot deletion uses identity and version preconditions, so an old API cannot release a new owner', async () => {
  const kube = new FakeKube(), manager = new RunManager(kube, config, offline);
  await manager.create(input);
  const original = await kube.get('configmaps', SLOT);
  await kube.delete('configmaps', SLOT, original.metadata);
  await kube.create('configmaps', manager.resource(SLOT, {input: {...input, runId: 'new-owner'}}));
  await assert.rejects(manager.release(original), {code: 'KUBE_CONFLICT'});
  assert.equal(JSON.parse((await kube.get('configmaps', SLOT)).data.record).input.runId, 'new-owner');
});
