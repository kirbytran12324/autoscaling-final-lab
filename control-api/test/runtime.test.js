'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {readConfig} = require('../src/config');
const {startServer} = require('../src/server');

const environment = {CONTROL_NAMESPACE: 'lab', RUNNER_IMAGE: 'runner:test', RUNNER_STATE_CLAIM: 'state',
  ARCHIVE_CLAIM: 'archives', RUNNER_STATUS_SECRET: 'status', SIMULATOR_BASE_URL: 'http://simulator',
  RULES_VERSION: 'rules', SIMULATOR_VERSION: 'version', CONTROL_OPERATOR_TOKEN: 'o'.repeat(32),
  RUNNER_STATUS_TOKEN: 's'.repeat(32), RUNNER_STATUS_URL: 'http://runner-status:3003'};

test('startup rejects missing, invalid, or shared tokens and malformed configuration', () => {
  assert.throws(() => readConfig({}), /required/);
  assert.throws(() => readConfig({...environment, CONTROL_NAMESPACE: '../escape'}), /DNS label/);
  assert.throws(() => readConfig({...environment, CONTROL_MAX_CONCURRENCY: '1000'}), /invalid/);
  assert.throws(() => readConfig({...environment, RUNNER_STATUS_TOKEN: environment.CONTROL_OPERATOR_TOKEN}), /distinct tokens/);
  assert.equal(readConfig(environment).statusPort, 3003);
});

test('production server is live but not ready without Kubernetes credentials and never starts Jobs on deployment', async t => {
  // No cluster credentials are mounted in the application test container.
  const oldHost = process.env.KUBERNETES_SERVICE_HOST;
  process.env.KUBERNETES_SERVICE_HOST = '127.0.0.1';
  t.after(() => {if (oldHost === undefined) delete process.env.KUBERNETES_SERVICE_HOST; else process.env.KUBERNETES_SERVICE_HOST = oldHost;});
  const server = startServer({...readConfig(environment), port: 0, host: '127.0.0.1'});
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/health/live')).status, 200);
  assert.equal((await fetch(base + '/health/ready')).status, 503);
  assert.equal((await fetch(base + '/api/control/runs')).status, 401);
});
