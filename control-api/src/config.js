'use strict';
const {readAuthConfig} = require('./auth');
const {ControlError} = require('./errors');
const NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function validateInput(body, maximum = 16) {
  if (!body || Array.isArray(body) || typeof body !== 'object' ||
      Object.keys(body).some(key => !['runId', 'mode', 'seed', 'concurrency'].includes(key)) ||
      typeof body.runId !== 'string' || !NAME.test(body.runId) || body.runId.length > 40 ||
      !['sample', 'full'].includes(body.mode) || typeof body.seed !== 'string' ||
      body.seed.trim() !== body.seed || !body.seed.length || body.seed.length > 128 ||
      /[\x00-\x1f\x7f]/.test(body.seed) || !Number.isInteger(body.concurrency) ||
      body.concurrency < 1 || body.concurrency > maximum) {
    throw new ControlError(400, 'INVALID_RUN',
      `Provide a DNS-style run ID (1–40 characters), sample/full mode, seed (1–128 characters), and concurrency between 1 and ${maximum}.`);
  }
  return {runId: body.runId, mode: body.mode, seed: body.seed, concurrency: body.concurrency};
}

function readConfig(env = process.env) {
  const required = name => {
    if (!env[name]?.trim()) throw new Error(`${name} is required`);
    return env[name].trim();
  };
  const integer = (name, fallback, max = 65535) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} is invalid`);
    return value;
  };
  const name = key => {
    const value = required(key);
    if (!NAME.test(value) || value.length > 63) throw new Error(`${key} must be a DNS label`);
    return value;
  };
  const config = {namespace: name('CONTROL_NAMESPACE'), image: required('RUNNER_IMAGE'),
    stateClaim: name('RUNNER_STATE_CLAIM'), archiveClaim: name('ARCHIVE_CLAIM'),
    secretName: name('RUNNER_STATUS_SECRET'), simulatorUrl: required('SIMULATOR_BASE_URL'),
    rulesVersion: required('RULES_VERSION'), simulatorVersion: required('SIMULATOR_VERSION'),
    auth: readAuthConfig(env), statusToken: required('RUNNER_STATUS_TOKEN'),
    statusUrl: required('RUNNER_STATUS_URL'), statusPort: integer('RUNNER_STATUS_PORT', 3003),
    maxConcurrency: integer('CONTROL_MAX_CONCURRENCY', 16, 64), port: integer('PORT', 3002),
    host: env.HOST || '0.0.0.0'};
  for (const value of [config.simulatorUrl, config.statusUrl]) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Service URLs must be HTTP(S) without credentials or query parameters');
    }
  }
  if (config.statusToken.length < 32 || config.auth.token === config.statusToken) {
    throw new Error('Use two distinct tokens, each at least 32 characters long');
  }
  if (!/^[a-zA-Z0-9./:_@-]+$/.test(config.image)) throw new Error('RUNNER_IMAGE is invalid');
  return config;
}

module.exports = {readConfig, validateInput};
