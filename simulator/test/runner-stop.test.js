'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {readFile} = require('node:fs/promises');
const {join} = require('node:path');
const {planTournamentRun, executeGroupStagePlan, executeKnockoutPlan} = require('../src/runner');
const {createStateRoot, runIdentity, acceptedRecord} = require('../test-support/runner');
const {transitionedTournament, responseForRequest} = require('../test-support/runner-knockout');
const {runCli} = require('../src/runner-cli');
const {runTournament} = require('../src/runner');
const {readJsonLines} = require('../src/runner-state');

test('group graceful stop drains accepted writes, leaves running metadata, and replan skips accepted battles', async t => {
  const stateRoot = await createStateRoot(t), identity = runIdentity({runnerConcurrency: 1});
  const plan = await planTournamentRun({stateRoot, identity});
  let stopped = false; const events = [];
  const result = await executeGroupStagePlan(plan, {shouldStop: () => stopped,
    runBattle: async request => {stopped = true; return acceptedRecord(request, identity);},
    onEvent: event => events.push(event)});
  assert.equal(result.interrupted, true);
  assert.equal(events[0].type, 'battle-accepted');
  assert.equal(events[0].acceptedResultCount, 1);
  const recovered = await planTournamentRun({stateRoot, identity});
  assert.equal(recovered.acceptedResultCount, 1);
  assert.equal(recovered.metadata.status, 'running');
  assert.equal(recovered.missingGroupMatches.some(m => m.matchId === events[0].matchId), false);
  assert.equal(JSON.parse(await readFile(join(plan.runDirectory, 'checkpoint.json'), 'utf8')).acceptedResultCount, 1);
});

test('knockout graceful stop preserves accepted game and does not mark tournament failed', async t => {
  const fixture = await transitionedTournament(t, runIdentity({runnerConcurrency: 1}));
  const {plan, identity} = fixture;
  let stopped = false;
  const result = await executeKnockoutPlan(plan, {shouldStop: () => stopped,
    runBattle: async request => {stopped = true; return responseForRequest(request,
      plan.rounds[0].series.find(series => series.seriesId === request.seriesId), identity);}});
  assert.equal(result.interrupted, true);
  const metadata = JSON.parse(await readFile(join(plan.runDirectory, 'run-metadata.json'), 'utf8'));
  assert.equal(metadata.status, 'running');
});

test('CLI SIGTERM asks orchestration to stop, cleans listeners, and returns interrupted exit', async () => {
  const signals = new EventEmitter();
  const env = {TOURNAMENT_RUN_ID: 'sample', TOURNAMENT_MODE: 'sample', TOURNAMENT_SEED: 'seed',
    TOURNAMENT_STATE_ROOT: '/state', SIMULATOR_BASE_URL: 'http://simulator', RUNNER_CONCURRENCY: '2',
    RULES_VERSION: 'rules', SIMULATOR_VERSION: 'version', SIMULATOR_IMAGE: 'image'};
  const code = await runCli({env, args: [], signalSource: signals, stdout: () => {}, stderr: () => {},
    createSimulatorClientImpl: () => ({}), runTournamentImpl: async options => {
      assert.equal(options.shouldStop(), false); signals.emit('SIGTERM');
      assert.equal(options.shouldStop(), true); return {interrupted: true};
    }});
  assert.equal(code, 130); assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('group and knockout interruption resume to exactly the same accepted results as uninterrupted execution', async t => {
  const resumedRoot = await createStateRoot(t), baselineRoot = await createStateRoot(t);
  const identity = runIdentity({runnerConcurrency: 1});
  const client = {runBattle: async request => acceptedRecord(request, identity)};
  let stopping = false;
  const first = await runTournament({stateRoot: resumedRoot, identity, simulatorClient: client,
    shouldStop: () => stopping, onEvent: event => { if (event.type === 'battle-accepted') stopping = true; }});
  assert.equal(first.interrupted, true);
  stopping = false;
  const second = await runTournament({stateRoot: resumedRoot, identity, simulatorClient: client,
    shouldStop: () => stopping, onEvent: event => { if (event.type === 'battle-accepted' && event.stage === 'knockout') stopping = true; }});
  assert.equal(second.interrupted, true);
  const resumed = await runTournament({stateRoot: resumedRoot, identity, simulatorClient: client});
  const baseline = await runTournament({stateRoot: baselineRoot, identity, simulatorClient: client});
  assert.equal(resumed.tournamentComplete, true); assert.equal(baseline.tournamentComplete, true);
  const resumedRecords = await readJsonLines(join(resumed.runDirectory, 'results.jsonl'));
  assert.deepEqual(resumedRecords, await readJsonLines(join(baseline.runDirectory, 'results.jsonl')));
  assert.equal(new Set(resumedRecords.map(record => record.matchId)).size, resumedRecords.length);
});
