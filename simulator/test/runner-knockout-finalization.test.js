'use strict';

const assert = require('node:assert/strict');
const {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const test = require('node:test');
const {
  buildKnockoutRecoveryPlan,
  executeKnockoutPlan,
  planTournamentRun,
} = require('../src/runner');
const {
  appendJsonLine: appendStateJsonLine,
  atomicWriteJson: atomicWriteStateJson,
  readJsonLines,
} = require('../src/runner-state');
const {
  buildNextKnockoutRound,
  evaluateKnockoutSeries,
  generateKnockoutSeriesGame,
} = require('../src/tournament');
const {
  INITIAL_TIME,
  runIdentity,
  checkpoint,
  acceptedRecord,
  acceptedKnockoutRecord,
  createStateRoot,
  writeJson,
  writeRecords,
  readEvidence,
  deferred,
  waitFor,
  transitionedTournament,
  replan,
  completedSeriesRecords,
  responseForRequest,
  planWithOnlyLastSeriesIncomplete,
  planAtFinalRound
} = require('../test-support/runner-knockout');

test('completed round writes enriched bracket before the next checkpoint', async t => {
  const fixture = await transitionedTournament(t, runIdentity({
    runId: 'knockout-round-barrier',
  }));
  const seriesById = new Map(fixture.plan.rounds[0].series.map(series => [
    series.seriesId,
    series,
  ]));
  const calls = [];
  const writes = [];

  await executeKnockoutPlan(fixture.plan, {
    async runBattle(request) {
      calls.push(request);
      return responseForRequest(
        request,
        seriesById.get(request.seriesId),
        fixture.identity
      );
    },
    async appendJsonLine() {},
    async atomicWriteJson(path, value) {
      writes.push({name: path.split('/').at(-1), value: structuredClone(value)});
    },
    now: () => INITIAL_TIME,
  });

  const bracketWrite = writes.at(-2);
  const checkpointWrite = writes.at(-1);
  assert.equal(bracketWrite.name, 'bracket.json');
  assert.equal(checkpointWrite.name, 'checkpoint.json');
  assert.deepEqual(bracketWrite.value.rounds.map(round => round.round), [
    'r16', 'r8',
  ]);
  assert.ok(bracketWrite.value.rounds[0].series.every(series =>
    series.games.length === 2 &&
    series.games[0].gameNumber === 1 &&
    series.games[1].gameNumber === 2 &&
    series.evaluation.status === 'complete'
  ));
  assert.ok(bracketWrite.value.rounds[1].series.every(series =>
    !Object.hasOwn(series, 'games') && !Object.hasOwn(series, 'evaluation')
  ));
  assert.equal(checkpointWrite.value.round, 'r8');
  assert.ok(calls.every(request => request.matchId.startsWith('r16-')));
});

test('normal round barrier interruption recovers without next-round HTTP', async t => {
  const prepared = await planWithOnlyLastSeriesIncomplete(t, {
    runId: 'knockout-round-barrier-retry',
  });
  const firstWin = acceptedKnockoutRecord(
    prepared.series,
    1,
    prepared.fixture.identity,
    'entrant1'
  );
  const plan = await replan(
    prepared.fixture,
    [...prepared.records, firstWin]
  );
  const checkpointError = new Error('next-round checkpoint interrupted');

  await assert.rejects(executeKnockoutPlan(plan, {
    async runBattle(request) {
      return responseForRequest(
        request,
        prepared.series,
        prepared.fixture.identity
      );
    },
    async atomicWriteJson(path, value) {
      if (path.endsWith('checkpoint.json') && value.round === 'r8') {
        throw checkpointError;
      }
      await atomicWriteStateJson(path, value);
    },
    now: () => INITIAL_TIME,
  }), error => error === checkpointError);

  const recovered = await planTournamentRun({
    stateRoot: prepared.fixture.stateRoot,
    identity: prepared.fixture.identity,
  });
  assert.equal(recovered.round, 'r8');
  let requestCalls = 0;
  const summary = await executeKnockoutPlan(recovered, {
    async runBattle() {
      requestCalls++;
      throw new Error('next round must not execute during barrier retry');
    },
    now: () => INITIAL_TIME,
  });

  assert.equal(requestCalls, 0);
  assert.equal(summary.round, 'r8');
  assert.equal(summary.requestedMatchCount, 0);
  const durableCheckpoint = JSON.parse(await readFile(
    join(prepared.fixture.runDirectory, 'checkpoint.json'),
    'utf8'
  ));
  assert.equal(durableCheckpoint.round, 'r8');
  assert.equal(durableCheckpoint.schedulePosition, 0);
});

test('final completion writes bracket, checkpoint, then metadata', async t => {
  const {fixture, plan, series} = await planAtFinalRound(t, {
    runId: 'knockout-final-order',
  });
  const writes = [];

  const summary = await executeKnockoutPlan(plan, {
    async runBattle(request) {
      return responseForRequest(request, series, fixture.identity);
    },
    async appendJsonLine() {},
    async atomicWriteJson(path, value) {
      writes.push({name: path.split('/').at(-1), value: structuredClone(value)});
    },
    now: () => INITIAL_TIME,
  });

  assert.deepEqual(writes.slice(-3).map(write => write.name), [
    'bracket.json',
    'checkpoint.json',
    'run-metadata.json',
  ]);
  const [bracketWrite, checkpointWrite, metadataWrite] = writes.slice(-3);
  assert.equal(bracketWrite.value.status, 'completed');
  assert.equal(bracketWrite.value.rounds.at(-1).series[0].games.length, 2);
  assert.equal(bracketWrite.value.rounds.at(-1).series[0].evaluation.status, 'complete');
  assert.deepEqual(bracketWrite.value.champion, summary.champion);
  assert.equal(checkpointWrite.value.stage, 'complete');
  assert.equal(checkpointWrite.value.round, 'r2');
  assert.equal(checkpointWrite.value.schedulePosition, 2);
  assert.equal(checkpointWrite.value.acceptedResultCount, 142);
  assert.equal(metadataWrite.value.status, 'completed');
  assert.equal(metadataWrite.value.completedAt, INITIAL_TIME);
  assert.equal(summary.stage, 'complete');
  assert.equal(summary.tournamentComplete, true);
});

test('final completion interruption is safely repeatable', async t => {
  const prepared = await planAtFinalRound(t, {
    runId: 'knockout-final-retry',
  });
  const metadataError = new Error('metadata completion interrupted');

  await assert.rejects(executeKnockoutPlan(prepared.plan, {
    async runBattle(request) {
      return responseForRequest(
        request,
        prepared.series,
        prepared.fixture.identity
      );
    },
    async atomicWriteJson(path, value) {
      if (path.endsWith('run-metadata.json') && value.status === 'completed') {
        throw metadataError;
      }
      await atomicWriteStateJson(path, value);
    },
    now: () => INITIAL_TIME,
  }), error => error === metadataError);

  const recovered = await planTournamentRun({
    stateRoot: prepared.fixture.stateRoot,
    identity: prepared.fixture.identity,
  });
  assert.equal(recovered.stage, 'knockout');
  assert.equal(recovered.resultComplete, true);
  assert.equal(recovered.tournamentComplete, false);
  assert.deepEqual(recovered.nextGameRequests, []);
  let requestCalls = 0;

  const summary = await executeKnockoutPlan(recovered, {
    async runBattle() {
      requestCalls++;
      throw new Error('completed final must not be re-executed');
    },
    now: () => INITIAL_TIME,
  });

  assert.equal(requestCalls, 0);
  assert.equal(summary.stage, 'complete');
  const terminal = await planTournamentRun({
    stateRoot: prepared.fixture.stateRoot,
    identity: prepared.fixture.identity,
  });
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.status, 'completed');
  assert.equal((await readJsonLines(
    join(prepared.fixture.runDirectory, 'results.jsonl')
  )).length, 142);
});

test('knockout execution preserves its supplied plan', async t => {
  const prepared = await planWithOnlyLastSeriesIncomplete(t, {
    runId: 'knockout-execution-input-preservation',
  });
  const snapshot = JSON.stringify(prepared.plan);

  await executeKnockoutPlan(prepared.plan, {
    async runBattle(request) {
      return responseForRequest(
        request,
        prepared.series,
        prepared.fixture.identity
      );
    },
    async appendJsonLine() {},
    async atomicWriteJson() {},
    now: () => INITIAL_TIME,
  });

  assert.equal(JSON.stringify(prepared.plan), snapshot);
});

test('knockout execution requires an active non-terminal plan', async t => {
  const {plan} = await planWithOnlyLastSeriesIncomplete(t, {
    runId: 'knockout-execution-plan-state',
  });

  for (const invalidPlan of [
    {...plan, terminal: true},
    {...plan, stage: 'complete'},
    {...plan, tournamentComplete: true},
  ]) {
    await assert.rejects(
      executeKnockoutPlan(invalidPlan),
      /non-terminal, incomplete knockout plan/i
    );
  }
});
