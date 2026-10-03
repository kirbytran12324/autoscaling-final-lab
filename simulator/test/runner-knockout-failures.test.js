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

test('request failure drains already-started knockout successes', async t => {
  const fixture = await transitionedTournament(t, runIdentity({
    runId: 'knockout-request-drain',
    runnerConcurrency: 3,
  }));
  const round = fixture.plan.rounds[0];
  const records = [
    ...round.series.slice(0, 5).flatMap(series =>
      completedSeriesRecords(series, fixture.identity)
    ),
    ...round.series.slice(5).map(series =>
      acceptedKnockoutRecord(series, 1, fixture.identity, 'entrant1')
    ),
  ];
  const plan = await replan(fixture, records);
  const requests = new Map();
  const events = [];
  const requestError = new Error('client retries exhausted');

  const execution = executeKnockoutPlan(plan, {
    runBattle(request) {
      const operation = deferred();
      requests.set(request.seriesId, {operation, request});
      return operation.promise;
    },
    async appendJsonLine(path, value) {
      events.push(`append:${value.matchId}`);
    },
    async appendFailureJsonLine(path, value) {
      events.push(`failure:${value.matchId}`);
      await appendStateJsonLine(path, value);
    },
    async atomicWriteJson(path, value) {
      events.push(`${path.split('/').at(-1)}:${value.status || value.stage}`);
    },
    now: () => INITIAL_TIME,
  });

  await waitFor(() => requests.size === 3);
  const pending = [...requests.values()];
  pending[0].operation.reject(requestError);

  for (const {operation, request} of pending.slice(1)) {
    const series = round.series.find(entry => entry.seriesId === request.seriesId);
    operation.resolve(responseForRequest(
      request,
      series,
      fixture.identity
    ));
  }

  await assert.rejects(execution, error => {
    assert.strictEqual(error.cause, requestError);
    return true;
  });

  assert.equal(requests.size, 3);
  assert.equal(events.filter(event => event.startsWith('append:')).length, 2);
  assert.equal(events.at(-1), 'run-metadata.json:failed');
  assert.match(events.at(-2), /^failure:r16-series-/);

  const failure = JSON.parse(await readFile(
    join(plan.runDirectory, 'failures.jsonl'),
    'utf8'
  ));
  assert.equal(failure.stage, 'knockout');
  assert.equal(failure.round, 'r16');
  assert.equal(failure.matchId, pending[0].request.matchId);
  assert.deepEqual(failure.request, pending[0].request);
});

test('knockout storage failures do not mark metadata failed', async t => {
  await t.test('append failure', async t => {
    const {fixture, plan, series} = await planWithOnlyLastSeriesIncomplete(t, {
      runId: 'knockout-append-failure',
    });
    const storageError = new Error('append failed');
    let writeCalls = 0;

    await assert.rejects(executeKnockoutPlan(plan, {
      async runBattle(request) {
        return responseForRequest(request, series, fixture.identity);
      },
      async appendJsonLine() {
        throw storageError;
      },
      async atomicWriteJson() {
        writeCalls++;
      },
    }), error => error === storageError);

    assert.equal(writeCalls, 0);
  });

  await t.test('checkpoint failure after append', async t => {
    const {fixture, plan, series} = await planWithOnlyLastSeriesIncomplete(t, {
      runId: 'knockout-checkpoint-failure',
    });
    const storageError = new Error('checkpoint failed');
    const events = [];

    await assert.rejects(executeKnockoutPlan(plan, {
      async runBattle(request) {
        return responseForRequest(request, series, fixture.identity);
      },
      async appendJsonLine() {
        events.push('append');
      },
      async atomicWriteJson(path) {
        events.push(path.split('/').at(-1));
        throw storageError;
      },
    }), error => error === storageError);

    assert.deepEqual(events, ['append', 'checkpoint.json']);
  });

  await t.test('bracket failure', async t => {
    const prepared = await planWithOnlyLastSeriesIncomplete(t, {
      runId: 'knockout-bracket-failure',
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
    const storageError = new Error('bracket failed');
    const writes = [];

    await assert.rejects(executeKnockoutPlan(plan, {
      async runBattle(request) {
        return responseForRequest(
          request,
          prepared.series,
          prepared.fixture.identity
        );
      },
      async appendJsonLine() {},
      async atomicWriteJson(path) {
        writes.push(path.split('/').at(-1));
        if (path.endsWith('bracket.json')) throw storageError;
      },
      now: () => INITIAL_TIME,
    }), error => error === storageError);

    assert.deepEqual(writes, ['checkpoint.json', 'bracket.json']);
    assert.ok(!writes.includes('run-metadata.json'));
  });
});
