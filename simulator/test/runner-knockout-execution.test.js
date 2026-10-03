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

test('knockout execution runs series concurrently but games serially', async t => {
  const fixture = await transitionedTournament(t, runIdentity({
    runId: 'knockout-execution-concurrency',
    runnerConcurrency: 3,
  }));
  const plan = fixture.plan;
  const seriesById = new Map(plan.rounds[0].series.map(series => [
    series.seriesId,
    series,
  ]));
  const activeBySeries = new Map();
  const maximumBySeries = new Map();
  const calls = [];
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  let activePersistence = 0;
  let maximumActivePersistence = 0;

  async function persist() {
    activePersistence++;
    maximumActivePersistence = Math.max(
      maximumActivePersistence,
      activePersistence
    );
    await new Promise(resolve => setImmediate(resolve));
    activePersistence--;
  }

  const summary = await executeKnockoutPlan(plan, {
    async runBattle(request) {
      calls.push(request);
      activeRequests++;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      const seriesActive = (activeBySeries.get(request.seriesId) || 0) + 1;
      activeBySeries.set(request.seriesId, seriesActive);
      maximumBySeries.set(
        request.seriesId,
        Math.max(maximumBySeries.get(request.seriesId) || 0, seriesActive)
      );
      await new Promise(resolve => setImmediate(resolve));
      activeBySeries.set(request.seriesId, seriesActive - 1);
      activeRequests--;
      return responseForRequest(
        request,
        seriesById.get(request.seriesId),
        fixture.identity
      );
    },
    appendJsonLine: persist,
    atomicWriteJson: persist,
    now: () => INITIAL_TIME,
  });

  assert.equal(maximumActiveRequests, 3);
  assert.equal(maximumActivePersistence, 1);
  assert.ok([...maximumBySeries.values()].every(maximum => maximum === 1));
  assert.equal(calls.length, 16);
  assert.equal(new Set(calls.map(request => request.matchId)).size, 16);
  assert.ok(calls.every(request => request.matchId.startsWith('r16-')));
  assert.deepEqual(summary, {
    stage: 'knockout',
    round: 'r8',
    tournamentComplete: false,
    requestedMatchCount: 16,
    acceptedMatchCount: 16,
    acceptedResultCount: 128,
    schedulePosition: 0,
  });
});

test('draws advance sequentially and two wins stop the series', async t => {
  const {fixture, plan, series} = await planWithOnlyLastSeriesIncomplete(t, {
    runId: 'knockout-draw-sequence',
  });
  const calls = [];
  const outcomes = ['tie', 'entrant1', 'entrant1'];

  await executeKnockoutPlan(plan, {
    async runBattle(request) {
      calls.push(request);
      return responseForRequest(
        request,
        series,
        fixture.identity,
        outcomes[calls.length - 1]
      );
    },
    async appendJsonLine() {},
    async atomicWriteJson() {},
    now: () => INITIAL_TIME,
  });

  assert.deepEqual(calls.map(request => request.gameNumber), [1, 2, 3]);
  assert.deepEqual(calls.map(request => request.matchId), [
    `${series.seriesId}-game-01`,
    `${series.seriesId}-game-02`,
    `${series.seriesId}-game-03`,
  ]);
});

test('a knockout series stops immediately after its second win', async t => {
  const {fixture, plan, series} = await planWithOnlyLastSeriesIncomplete(t, {
    runId: 'knockout-two-win-stop',
  });
  const calls = [];

  await executeKnockoutPlan(plan, {
    async runBattle(request) {
      calls.push(request);
      return responseForRequest(request, series, fixture.identity);
    },
    async appendJsonLine() {},
    async atomicWriteJson() {},
    now: () => INITIAL_TIME,
  });

  assert.deepEqual(calls.map(request => request.gameNumber), [1, 2]);
});

test('seven draws stop at the cap and persist the hash lottery', async t => {
  const {fixture, plan, series} = await planWithOnlyLastSeriesIncomplete(t, {
    runId: 'knockout-hash-lottery-execution',
  });
  const calls = [];
  const writes = [];

  await executeKnockoutPlan(plan, {
    async runBattle(request) {
      calls.push(request);
      return responseForRequest(
        request,
        series,
        fixture.identity,
        'tie'
      );
    },
    async appendJsonLine() {},
    async atomicWriteJson(path, value) {
      writes.push({path, value: structuredClone(value)});
    },
    now: () => INITIAL_TIME,
  });

  const bracket = writes.find(write => write.path.endsWith('bracket.json'))
    .value;
  const completedSeries = bracket.rounds[0].series.at(-1);
  assert.deepEqual(calls.map(request => request.gameNumber), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(completedSeries.games.length, 7);
  assert.equal(completedSeries.evaluation.resolution, 'hash-lottery');
  assert.match(completedSeries.evaluation.lotteryHash, /^[0-9a-f]{64}$/);
});

test('knockout acceptance appends before checkpoints with absolute counts', async t => {
  const prepared = await planWithOnlyLastSeriesIncomplete(t, {
    runId: 'knockout-acceptance-order',
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
  const events = [];

  const summary = await executeKnockoutPlan(plan, {
    async runBattle(request) {
      return responseForRequest(
        request,
        prepared.series,
        prepared.fixture.identity
      );
    },
    async appendJsonLine(path, value) {
      events.push({kind: 'append', path, value: structuredClone(value)});
    },
    async atomicWriteJson(path, value) {
      events.push({kind: path.split('/').at(-1), value: structuredClone(value)});
    },
    now: () => INITIAL_TIME,
  });

  assert.equal(events[0].kind, 'append');
  assert.equal(events[1].kind, 'checkpoint.json');
  assert.equal(events[1].value.round, 'r16');
  assert.equal(events[1].value.schedulePosition, 16);
  assert.equal(events[1].value.acceptedResultCount, 128);
  assert.equal(events.at(-2).kind, 'bracket.json');
  assert.equal(events.at(-1).kind, 'checkpoint.json');
  assert.equal(events.at(-1).value.round, 'r8');
  assert.equal(events.at(-1).value.schedulePosition, 0);
  assert.equal(events.at(-1).value.acceptedResultCount, 128);
  assert.equal(summary.acceptedResultCount, 128);
});

test('knockout execution rejects invalid responses without appending', async t => {
  const {fixture, plan} = await planWithOnlyLastSeriesIncomplete(t, {
    runId: 'knockout-invalid-response',
  });
  const writes = [];
  let appendCalls = 0;

  await assert.rejects(
    executeKnockoutPlan(plan, {
      async runBattle(request) {
        return acceptedRecord(request, fixture.identity, {
          pokemon1: 'Pikachu',
        });
      },
      async appendJsonLine() {
        appendCalls++;
      },
      async atomicWriteJson(path, value) {
        writes.push({path, value});
      },
      now: () => INITIAL_TIME,
    }),
    error => {
      assert.match(error.cause.message, /pokemon1.*match the request/i);
      return true;
    }
  );

  assert.equal(appendCalls, 0);
  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /run-metadata\.json$/);
  assert.equal(writes[0].value.status, 'failed');
});
