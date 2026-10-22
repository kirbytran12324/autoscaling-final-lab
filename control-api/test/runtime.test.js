'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {readConfig} = require('../src/config');
const {startServer} = require('../src/server');
const {environment: albEnvironment} = require('./alb-fixture');

const environment = {CONTROL_AUTH_MODE: 'bearer', CONTROL_NAMESPACE: 'lab', RUNNER_IMAGE: 'runner:test', RUNNER_STATE_CLAIM: 'state',
  ARCHIVE_CLAIM: 'archives', RUNNER_STATUS_SECRET: 'status', SIMULATOR_BASE_URL: 'http://simulator',
  RULES_VERSION: 'rules', SIMULATOR_VERSION: 'version', CONTROL_OPERATOR_TOKEN: 'o'.repeat(32),
  RUNNER_STATUS_TOKEN: 's'.repeat(32), RUNNER_STATUS_URL: 'http://runner-status:3003'};

function isolateKubernetes(t) {
  const oldHost = process.env.KUBERNETES_SERVICE_HOST;
  process.env.KUBERNETES_SERVICE_HOST = '127.0.0.1';
  t.after(() => {if (oldHost === undefined) delete process.env.KUBERNETES_SERVICE_HOST; else process.env.KUBERNETES_SERVICE_HOST = oldHost;});
}

test('startup rejects missing, invalid, or shared tokens and malformed configuration', () => {
  assert.throws(() => readConfig({}), /required/);
  assert.throws(() => readConfig({...environment, CONTROL_NAMESPACE: '../escape'}), /DNS label/);
  assert.throws(() => readConfig({...environment, CONTROL_MAX_CONCURRENCY: '1000'}), /invalid/);
  assert.throws(() => readConfig({...environment, RUNNER_STATUS_TOKEN: environment.CONTROL_OPERATOR_TOKEN}), /distinct tokens/);
  assert.equal(readConfig(environment).statusPort, 3003);
  assert.throws(() => readConfig({...environment, CONTROL_AUTH_MODE: undefined}), /CONTROL_AUTH_MODE/);
  const managed = readConfig({...environment, ...albEnvironment, CONTROL_OPERATOR_TOKEN: undefined});
  assert.equal(managed.auth.mode, 'alb');
  assert.equal(managed.auth.token, undefined);
});

test('production server is live but not ready without Kubernetes credentials and never starts Jobs on deployment', async t => {
  // No cluster credentials are mounted in the application test container.
  isolateKubernetes(t);
  const server = startServer({...readConfig(environment), port: 0, host: '127.0.0.1'});
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/health/live')).status, 200);
  assert.equal((await fetch(base + '/health/ready')).status, 503);
  assert.equal((await fetch(base + '/api/control/runs')).status, 401);
});

test('production ALB startup needs no operator token, exposes minimal health and rejects unsigned callers', async t => {
  isolateKubernetes(t);
  const server = startServer({...readConfig({...environment, ...albEnvironment, CONTROL_OPERATOR_TOKEN: undefined}),
    port: 0, host: '127.0.0.1'});
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(base + '/health/live')).json(), {status: 'ok'});
  assert.equal((await fetch(base + '/api/control/session', {headers: {authorization: 'Bearer ' + 'o'.repeat(32),
    'x-amzn-oidc-identity': albEnvironment.CONTROL_OPERATOR_SUBJECTS}})).status, 401);
});
