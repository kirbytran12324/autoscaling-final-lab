'use strict';

const sampleRosterConfiguration = require('../config/sample_roster.json');
const {runTournament} = require('./runner');
const {resolveRunDirectory} = require('./runner-state');
const {createSimulatorClient} = require('./simulator-client');
const {selectTournamentRoster} = require('./tournament');

const REQUIRED_ENVIRONMENT = Object.freeze([
  'TOURNAMENT_RUN_ID',
  'TOURNAMENT_MODE',
  'TOURNAMENT_SEED',
  'TOURNAMENT_STATE_ROOT',
  'SIMULATOR_BASE_URL',
  'RUNNER_CONCURRENCY',
  'RULES_VERSION',
  'SIMULATOR_VERSION',
  'SIMULATOR_IMAGE',
]);

function requiredEnvironment(env, name) {
  const value = env[name];

  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} is required and must be non-empty`);
  }

  return value.trim();
}

function positiveInteger(value, name) {
  if (!/^\d+$/.test(value) || Number(value) <= 0 ||
      !Number.isSafeInteger(Number(value))) {
    throw new TypeError(`${name} must be a positive integer`);
  }

  return Number(value);
}

function nonNegativeInteger(value, name) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }

  return Number(value);
}

function parseRuntimeConfiguration(env) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('Environment must be an object');
  }

  const values = Object.fromEntries(REQUIRED_ENVIRONMENT.map(name => [
    name,
    requiredEnvironment(env, name),
  ]));

  if (values.TOURNAMENT_MODE !== 'sample' &&
      values.TOURNAMENT_MODE !== 'full') {
    throw new TypeError('TOURNAMENT_MODE must be "sample" or "full"');
  }

  let simulatorUrl;

  try {
    simulatorUrl = new URL(values.SIMULATOR_BASE_URL);
  } catch {
    throw new TypeError('SIMULATOR_BASE_URL must be a valid HTTP(S) URL');
  }

  if (simulatorUrl.protocol !== 'http:' && simulatorUrl.protocol !== 'https:') {
    throw new TypeError('SIMULATOR_BASE_URL must be a valid HTTP(S) URL');
  }

  const runnerConcurrency = positiveInteger(
    values.RUNNER_CONCURRENCY,
    'RUNNER_CONCURRENCY'
  );
  const requestTimeoutMs = env.SIMULATOR_REQUEST_TIMEOUT_MS === undefined
    ? undefined
    : nonNegativeInteger(
      requiredEnvironment(env, 'SIMULATOR_REQUEST_TIMEOUT_MS'),
      'SIMULATOR_REQUEST_TIMEOUT_MS'
    );
  const identity = {
    runId: values.TOURNAMENT_RUN_ID,
    mode: values.TOURNAMENT_MODE,
    tournamentSeed: values.TOURNAMENT_SEED,
    rulesVersion: values.RULES_VERSION,
    simulatorVersion: values.SIMULATOR_VERSION,
    simulatorImage: values.SIMULATOR_IMAGE,
    runnerConcurrency,
  };

  resolveRunDirectory(values.TOURNAMENT_STATE_ROOT, identity.runId);

  return {
    stateRoot: values.TOURNAMENT_STATE_ROOT,
    simulatorBaseUrl: simulatorUrl.toString().replace(/\/$/, ''),
    requestTimeoutMs,
    identity,
  };
}

function outputFunction(candidate, description) {
  if (typeof candidate !== 'function') {
    throw new TypeError(`${description} must be a function`);
  }

  return candidate;
}

async function runCli(options = {}) {
  const env = options.env === undefined ? process.env : options.env;
  const args = options.args === undefined ? process.argv.slice(2) : options.args;
  const stdout = outputFunction(
    options.stdout === undefined ? console.log : options.stdout,
    'stdout'
  );
  const stderr = outputFunction(
    options.stderr === undefined ? console.error : options.stderr,
    'stderr'
  );
  const runTournamentImpl = options.runTournamentImpl === undefined
    ? runTournament
    : options.runTournamentImpl;
  const createSimulatorClientImpl =
    options.createSimulatorClientImpl === undefined
      ? createSimulatorClient
      : options.createSimulatorClientImpl;
  const selectTournamentRosterImpl =
    options.selectTournamentRosterImpl === undefined
      ? selectTournamentRoster
      : options.selectTournamentRosterImpl;

  if (!Array.isArray(args) ||
      (args.length !== 0 &&
        !(args.length === 1 && args[0] === '--check-config'))) {
    stderr('Configuration error: the only supported argument is --check-config');
    return 1;
  }

  let configuration;

  try {
    configuration = parseRuntimeConfiguration(env);
  } catch (error) {
    stderr(`Configuration error: ${error.message}`);
    return 1;
  }

  if (args[0] === '--check-config') {
    try {
      const roster = selectTournamentRosterImpl(
        configuration.identity.mode,
        sampleRosterConfiguration
      );
      stdout(
        `Configuration valid: mode=${configuration.identity.mode} ` +
          `roster=${roster.length} runId=${configuration.identity.runId}`
      );
      return 0;
    } catch (error) {
      stderr(`Configuration error: roster selection failed: ${error.message}`);
      return 1;
    }
  }

  try {
    const clientOptions = {
      baseUrl: configuration.simulatorBaseUrl,
      expectedSimulatorVersion: configuration.identity.simulatorVersion,
    };

    if (configuration.requestTimeoutMs !== undefined) {
      clientOptions.timeoutMs = configuration.requestTimeoutMs;
    }

    const simulatorClient = createSimulatorClientImpl(clientOptions);
    stdout(
      `Tournament starting: runId=${configuration.identity.runId} ` +
        `mode=${configuration.identity.mode}`
    );
    const summary = await runTournamentImpl({
      stateRoot: configuration.stateRoot,
      identity: configuration.identity,
      simulatorClient,
      selectRoster(mode) {
        return selectTournamentRosterImpl(mode, sampleRosterConfiguration);
      },
      onProgress(progress) {
        const round = progress.round === undefined ? '' : ` round=${progress.round}`;
        stdout(
          `Tournament progress: stage=${progress.stage}${round} ` +
            `accepted=${progress.acceptedResultCount}`
        );
      },
    });

    if (summary.terminal === true && summary.status === 'completed' &&
        summary.tournamentComplete === true) {
      stdout(
        `Tournament completed: runId=${configuration.identity.runId} ` +
          `state=${summary.runDirectory}`
      );
      return 0;
    }

    stderr(
      `Tournament failed: runId=${configuration.identity.runId} ` +
        `status=${String(summary.status || summary.stage)}`
    );
    return 1;
  } catch (error) {
    stderr(`Tournament failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  runCli().then(exitCode => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  parseRuntimeConfiguration,
  runCli,
};
