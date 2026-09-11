'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseRuntimeConfiguration,
  runCli,
} = require('../src/runner-cli');

function validEnvironment(overrides = {}) {
  return {
    TOURNAMENT_RUN_ID: 'sample-2026-09-11',
    TOURNAMENT_MODE: 'sample',
    TOURNAMENT_SEED: 'phase-5-seed',
    TOURNAMENT_STATE_ROOT: '/state',
    SIMULATOR_BASE_URL: 'http://simulator.default.svc:3000',
    RUNNER_CONCURRENCY: '4',
    RULES_VERSION: 'rules-v1',
    SIMULATOR_VERSION: 'pokemon-showdown@0.11.11',
    SIMULATOR_IMAGE: 'metronome-simulator:phase-5',
    ...overrides,
  };
}

test('parseRuntimeConfiguration returns the runner and client contract', () => {
  assert.deepEqual(parseRuntimeConfiguration(validEnvironment({
    SIMULATOR_REQUEST_TIMEOUT_MS: '45000',
  })), {
    stateRoot: '/state',
    simulatorBaseUrl: 'http://simulator.default.svc:3000',
    requestTimeoutMs: 45000,
    identity: {
      runId: 'sample-2026-09-11',
      mode: 'sample',
      tournamentSeed: 'phase-5-seed',
      rulesVersion: 'rules-v1',
      simulatorVersion: 'pokemon-showdown@0.11.11',
      simulatorImage: 'metronome-simulator:phase-5',
      runnerConcurrency: 4,
    },
  });
});

test('runtime configuration rejects missing and invalid required values', () => {
  const missing = validEnvironment();
  delete missing.RULES_VERSION;
  assert.throws(
    () => parseRuntimeConfiguration(missing),
    /RULES_VERSION is required/i
  );

  for (const [name, value, pattern] of [
    ['TOURNAMENT_MODE', 'preview', /TOURNAMENT_MODE/],
    ['TOURNAMENT_RUN_ID', '../escape', /runId.*DNS-style/i],
    ['SIMULATOR_BASE_URL', 'simulator:3000', /valid HTTP/],
    ['RUNNER_CONCURRENCY', '0', /positive integer/],
    ['RUNNER_CONCURRENCY', '1.5', /positive integer/],
    ['SIMULATOR_REQUEST_TIMEOUT_MS', '-1', /non-negative integer/],
  ]) {
    assert.throws(
      () => parseRuntimeConfiguration(validEnvironment({[name]: value})),
      pattern
    );
  }
});

test('configuration smoke mode selects sample and full rosters without running',
  async t => {
    for (const [mode, count] of [['sample', 32], ['full', 1025]]) {
      await t.test(mode, async () => {
        const calls = [];
        const output = [];
        const exitCode = await runCli({
          env: validEnvironment({TOURNAMENT_MODE: mode}),
          args: ['--check-config'],
          stdout: message => output.push(message),
          stderr: () => assert.fail('smoke validation must not fail'),
          selectTournamentRosterImpl(selectedMode) {
            calls.push(selectedMode);
            return Array.from({length: count});
          },
          runTournamentImpl: () => assert.fail('must not start a tournament'),
          createSimulatorClientImpl: () => assert.fail('must not create a client'),
        });

        assert.equal(exitCode, 0);
        assert.deepEqual(calls, [mode]);
        assert.match(output[0], new RegExp(`mode=${mode} roster=${count}`));
      });
    }
  });

test('completed CLI execution delegates to existing orchestration', async () => {
  const output = [];
  const client = {runBattle() {}};
  let runnerOptions;
  const exitCode = await runCli({
    env: validEnvironment(),
    args: [],
    stdout: message => output.push(message),
    stderr: () => assert.fail('completed execution must not write stderr'),
    createSimulatorClientImpl(options) {
      assert.deepEqual(options, {
        baseUrl: 'http://simulator.default.svc:3000',
        expectedSimulatorVersion: 'pokemon-showdown@0.11.11',
      });
      return client;
    },
    selectTournamentRosterImpl(mode) {
      assert.equal(mode, 'sample');
      return ['selected-roster'];
    },
    async runTournamentImpl(options) {
      runnerOptions = options;
      assert.strictEqual(options.simulatorClient, client);
      assert.deepEqual(options.selectRoster('sample'), ['selected-roster']);
      await options.onProgress({
        stage: 'groups',
        acceptedResultCount: 10,
      });
      return {
        terminal: true,
        status: 'completed',
        tournamentComplete: true,
        runDirectory: '/state/runs/sample-2026-09-11',
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(runnerOptions.stateRoot, '/state');
  assert.equal(runnerOptions.identity.runId, 'sample-2026-09-11');
  assert.ok(output.some(message => message.includes('accepted=10')));
  assert.ok(output.some(message => message.includes('Tournament completed')));
});

test('failed terminal state and uncaught errors exit non-zero', async t => {
  for (const [name, runTournamentImpl, pattern] of [
    [
      'failed state',
      async () => ({
        terminal: true,
        status: 'failed',
        tournamentComplete: false,
      }),
      /status=failed/,
    ],
    [
      'execution error',
      async () => { throw new Error('simulator unavailable'); },
      /simulator unavailable/,
    ],
  ]) {
    await t.test(name, async () => {
      const errors = [];
      const exitCode = await runCli({
        env: validEnvironment(),
        args: [],
        stdout: () => {},
        stderr: message => errors.push(message),
        createSimulatorClientImpl: () => ({runBattle() {}}),
        runTournamentImpl,
      });

      assert.equal(exitCode, 1);
      assert.match(errors.at(-1), pattern);
    });
  }
});

test('invalid CLI configuration exits before creating dependencies', async () => {
  const errors = [];
  const env = validEnvironment();
  delete env.SIMULATOR_IMAGE;

  const exitCode = await runCli({
    env,
    args: [],
    stdout: () => {},
    stderr: message => errors.push(message),
    createSimulatorClientImpl: () => assert.fail('must not create a client'),
    runTournamentImpl: () => assert.fail('must not start a tournament'),
  });

  assert.equal(exitCode, 1);
  assert.match(errors[0], /SIMULATOR_IMAGE is required/i);
});
