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

const INITIAL_TIME = '2026-09-10T01:02:03.000Z';

function runIdentity(overrides = {}) {
  return {
    runId: 'sample-knockout-test',
    mode: 'sample',
    tournamentSeed: 'runner-knockout-seed',
    rulesVersion: 'rules-v1',
    simulatorVersion: 'pokemon-showdown@0.11.11',
    simulatorImage: 'metronome-simulator:test',
    runnerConcurrency: 4,
    ...overrides,
  };
}

function checkpoint(overrides = {}) {
  return {
    schemaVersion: 1,
    stage: 'knockout',
    round: 'r16',
    schedulePosition: 0,
    acceptedResultCount: 112,
    updatedAt: INITIAL_TIME,
    ...overrides,
  };
}

function acceptedRecord(request, identity, overrides = {}) {
  return {
    matchId: request.matchId,
    pokemon1: request.pokemon1,
    pokemon2: request.pokemon2,
    seed: [...request.seed],
    simulatorVersion: identity.simulatorVersion,
    outcome: 'tie',
    winnerSide: null,
    winnerSpecies: null,
    turns: 10,
    termination: 'natural',
    protocolHash: 'a'.repeat(64),
    servedBy: 'simulator-test',
    durationMs: 12.5,
    ...overrides,
  };
}

function acceptedKnockoutRecord(
  series,
  gameNumber,
  identity,
  result = 'tie',
  overrides = {}
) {
  const request = generateKnockoutSeriesGame(
    series,
    gameNumber,
    identity.tournamentSeed
  );

  if (result === 'tie') {
    return acceptedRecord(request, identity, overrides);
  }

  const winnerSpecies = series[result].species;
  return acceptedRecord(request, identity, {
    outcome: 'win',
    winnerSide: request.pokemon1 === winnerSpecies ? 'p1' : 'p2',
    winnerSpecies,
    ...overrides,
  });
}

async function createStateRoot(t) {
  const directory = await mkdtemp(join(tmpdir(), 'runner-knockout-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

async function writeRecords(runDirectory, records) {
  const contents = records.map(record => JSON.stringify(record)).join('\n');
  await writeFile(
    join(runDirectory, 'results.jsonl'),
    contents === '' ? '' : `${contents}\n`,
    'utf8'
  );
}

async function readEvidence(runDirectory) {
  const evidence = {};

  for (const fileName of (await readdir(runDirectory)).sort()) {
    evidence[fileName] = await readFile(join(runDirectory, fileName), 'utf8');
  }

  return evidence;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, reject, resolve};
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }

  throw new Error('Timed out waiting for test condition');
}

async function transitionedTournament(t, identity = runIdentity()) {
  const stateRoot = await createStateRoot(t);
  const groupPlan = await planTournamentRun({
    stateRoot,
    identity,
    now: () => INITIAL_TIME,
  });
  const groupRecords = groupPlan.groupSchedule.map(request =>
    acceptedRecord(request, identity)
  );
  await writeRecords(groupPlan.runDirectory, groupRecords);
  await writeJson(
    join(groupPlan.runDirectory, 'checkpoint.json'),
    checkpoint({
      round: identity.mode === 'sample' ? 'r16' : 'r64',
      acceptedResultCount: groupRecords.length,
    })
  );

  const plan = await planTournamentRun({stateRoot, identity});
  return {
    groupPlan,
    groupRecords,
    identity,
    plan,
    runDirectory: groupPlan.runDirectory,
    stateRoot,
  };
}

async function replan(fixture, knockoutRecords, checkpointValue) {
  await writeRecords(
    fixture.runDirectory,
    [...fixture.groupRecords, ...knockoutRecords]
  );

  if (checkpointValue !== undefined) {
    await writeJson(
      join(fixture.runDirectory, 'checkpoint.json'),
      checkpointValue
    );
  }

  return planTournamentRun({
    stateRoot: fixture.stateRoot,
    identity: fixture.identity,
  });
}

function completedSeriesRecords(series, identity, winner = 'entrant1') {
  return [1, 2].map(gameNumber => acceptedKnockoutRecord(
    series,
    gameNumber,
    identity,
    winner
  ));
}

function responseForRequest(request, series, identity, result = 'entrant1') {
  if (result === 'tie') {
    return acceptedRecord(request, identity);
  }

  const winnerSpecies = series[result].species;
  return acceptedRecord(request, identity, {
    outcome: 'win',
    winnerSide: request.pokemon1 === winnerSpecies ? 'p1' : 'p2',
    winnerSpecies,
  });
}

async function planWithOnlyLastSeriesIncomplete(t, overrides = {}) {
  const fixture = await transitionedTournament(t, runIdentity(overrides));
  const round = fixture.plan.rounds[0];
  const records = round.series.slice(0, -1).flatMap(series =>
    completedSeriesRecords(series, fixture.identity)
  );
  const plan = await replan(fixture, records);

  return {fixture, plan, series: round.series.at(-1), records};
}

async function planAtFinalRound(t, overrides = {}) {
  const fixture = await transitionedTournament(t, runIdentity(overrides));
  const records = [];
  let round = fixture.plan.rounds[0];

  while (round.round !== 'r2') {
    const evaluations = round.series.map(series => {
      const games = completedSeriesRecords(series, fixture.identity);
      records.push(...games);
      return evaluateKnockoutSeries(
        series,
        games.map((record, index) => ({
          ...record,
          seriesId: series.seriesId,
          gameNumber: index + 1,
        })),
        fixture.identity.tournamentSeed
      );
    });
    round = buildNextKnockoutRound(round, evaluations);
  }

  const plan = await replan(fixture, records, checkpoint({
    round: 'r2',
    schedulePosition: 0,
    acceptedResultCount: fixture.groupRecords.length + records.length,
  }));

  return {fixture, plan, records, series: round.series[0]};
}

test('a newly transitioned sample bracket plans eight game-one requests', async t => {
  const {plan} = await transitionedTournament(t);

  assert.equal(plan.stage, 'knockout');
  assert.equal(plan.round, 'r16');
  assert.equal(plan.activeRound, 'r16');
  assert.equal(plan.tournamentComplete, false);
  assert.equal(plan.rounds.length, 1);
  assert.equal(plan.rounds[0].series.length, 8);
  assert.equal(plan.nextGameRequests.length, 8);
  assert.ok(plan.nextGameRequests.every(request => request.gameNumber === 1));
  assert.equal(plan.completedSeriesEvaluations.length, 0);
  assert.equal(plan.acceptedGroupResultCount, 112);
  assert.equal(plan.acceptedKnockoutResultCount, 0);
  assert.equal(plan.acceptedResultCount, 112);
  assert.equal(plan.schedulePosition, 0);
});

test('one accepted win advances only that series to game two', async t => {
  const fixture = await transitionedTournament(t);
  const firstSeries = fixture.plan.rounds[0].series[0];
  const record = acceptedKnockoutRecord(
    firstSeries,
    1,
    fixture.identity,
    'entrant1'
  );
  const plan = await replan(fixture, [record]);

  assert.equal(plan.nextGameRequests.length, 8);
  assert.equal(plan.nextGameRequests[0].matchId, 'r16-series-01-game-02');
  assert.ok(plan.nextGameRequests.slice(1).every(request =>
    request.gameNumber === 1
  ));
  assert.equal(plan.seriesEvaluations[0].entrant1Wins, 1);
  assert.equal(plan.seriesEvaluations[1].gamesPlayed, 0);
  assert.equal(plan.acceptedResultCount, 113);
  assert.equal(plan.schedulePosition, 1);
});

test('an accepted draw consumes the game and schedules game two', async t => {
  const fixture = await transitionedTournament(t);
  const firstSeries = fixture.plan.rounds[0].series[0];
  const plan = await replan(fixture, [acceptedKnockoutRecord(
    firstSeries,
    1,
    fixture.identity,
    'tie'
  )]);

  assert.equal(plan.seriesEvaluations[0].draws, 1);
  assert.equal(plan.seriesEvaluations[0].entrant1Wins, 0);
  assert.equal(plan.nextGameRequests[0].matchId, 'r16-series-01-game-02');
});

test('two decisive wins complete one series without another request', async t => {
  const fixture = await transitionedTournament(t);
  const firstSeries = fixture.plan.rounds[0].series[0];
  const plan = await replan(
    fixture,
    completedSeriesRecords(firstSeries, fixture.identity)
  );

  assert.equal(plan.completedSeriesEvaluations.length, 1);
  assert.equal(plan.completedSeriesEvaluations[0].seriesId, firstSeries.seriesId);
  assert.equal(plan.nextGameRequests.length, 7);
  assert.ok(!plan.nextGameRequests.some(request =>
    request.seriesId === firstSeries.seriesId
  ));
});

test('incomplete series in one round remain independently schedulable', async t => {
  const fixture = await transitionedTournament(t);
  const [firstSeries, secondSeries] = fixture.plan.rounds[0].series;
  const plan = await replan(fixture, [
    acceptedKnockoutRecord(firstSeries, 1, fixture.identity, 'entrant1'),
    acceptedKnockoutRecord(secondSeries, 1, fixture.identity, 'tie'),
  ]);

  assert.equal(plan.nextGameRequests.length, 8);
  assert.deepEqual(
    plan.nextGameRequests.slice(0, 2).map(request => request.matchId),
    ['r16-series-01-game-02', 'r16-series-02-game-02']
  );
  assert.ok(plan.nextGameRequests.slice(2).every(request =>
    request.gameNumber === 1
  ));
});

test('a resolved round constructs and schedules the deterministic next round', async t => {
  const fixture = await transitionedTournament(t);
  const initialRound = fixture.plan.rounds[0];
  const records = initialRound.series.flatMap(series =>
    completedSeriesRecords(series, fixture.identity)
  );
  const plan = await replan(fixture, records);

  assert.deepEqual(plan.rounds.map(round => round.round), ['r16', 'r8']);
  assert.equal(plan.activeRound, 'r8');
  assert.equal(plan.completedSeriesEvaluations.length, 8);
  assert.equal(plan.nextGameRequests.length, 4);
  assert.ok(plan.nextGameRequests.every(request =>
    request.gameNumber === 1 && request.matchId.startsWith('r8-')
  ));
  assert.equal(
    plan.rounds[1].series[0].entrant1.sourceSeriesId,
    'r16-series-01'
  );
});

test('stale knockout checkpoint progress is reconciled without writing', async t => {
  const fixture = await transitionedTournament(t);
  const firstSeries = fixture.plan.rounds[0].series[0];
  const staleCheckpoint = checkpoint({
    stage: 'groups',
    round: null,
    schedulePosition: 999,
    acceptedResultCount: 3,
  });
  await writeRecords(fixture.runDirectory, [
    ...fixture.groupRecords,
    acceptedKnockoutRecord(firstSeries, 1, fixture.identity, 'tie'),
  ]);
  await writeJson(
    join(fixture.runDirectory, 'checkpoint.json'),
    staleCheckpoint
  );
  await writeJson(join(fixture.runDirectory, 'standings.json'), {
    status: 'stale',
    groups: [],
  });
  await writeJson(join(fixture.runDirectory, 'bracket.json'), {
    rounds: [],
    champion: {species: 'Not authoritative'},
  });
  const before = await readEvidence(fixture.runDirectory);

  const plan = await planTournamentRun({
    stateRoot: fixture.stateRoot,
    identity: fixture.identity,
  });

  assert.deepEqual(plan.checkpointHint, staleCheckpoint);
  assert.equal(plan.round, 'r16');
  assert.equal(plan.acceptedResultCount, 113);
  assert.equal(plan.schedulePosition, 1);
  assert.deepEqual(await readEvidence(fixture.runDirectory), before);
});

test('invalid knockout chronology and authority are rejected', async t => {
  await t.test('game two before game one', async t => {
    const fixture = await transitionedTournament(t, runIdentity({
      runId: 'knockout-reversed-games',
    }));
    const series = fixture.plan.rounds[0].series[0];

    await assert.rejects(
      replan(fixture, [
        acceptedKnockoutRecord(series, 2, fixture.identity, 'tie'),
        acceptedKnockoutRecord(series, 1, fixture.identity, 'tie'),
      ]),
      /out-of-order knockout game.*game 2.*before game 1/i
    );
  });

  await t.test('skipped game', async t => {
    const fixture = await transitionedTournament(t, runIdentity({
      runId: 'knockout-skipped-game',
    }));
    const series = fixture.plan.rounds[0].series[0];

    await assert.rejects(
      replan(fixture, [acceptedKnockoutRecord(
        series,
        2,
        fixture.identity,
        'tie'
      )]),
      /skipped knockout game.*expected game 1.*found game 2/i
    );
  });

  await t.test('future round', async t => {
    const fixture = await transitionedTournament(t, runIdentity({
      runId: 'knockout-future-round',
    }));
    const request = generateKnockoutSeriesGame(
      fixture.plan.rounds[0].series[0],
      1,
      fixture.identity.tournamentSeed
    );
    const record = acceptedRecord(request, fixture.identity, {
      matchId: 'r8-series-01-game-01',
    });

    await assert.rejects(
      replan(fixture, [record]),
      /future-round game.*cannot be derived until round r16 is complete/i
    );
  });

  await t.test('next round before the completed-round barrier', async t => {
    const fixture = await transitionedTournament(t, runIdentity({
      runId: 'knockout-early-next-round',
    }));
    const initialRound = fixture.plan.rounds[0];
    const evaluations = [];
    const r16Records = [];

    for (const series of initialRound.series) {
      const seriesRecords = completedSeriesRecords(
        series,
        fixture.identity
      );
      r16Records.push(...seriesRecords);
      evaluations.push(evaluateKnockoutSeries(
        series,
        seriesRecords.map((record, index) => ({
          ...record,
          seriesId: series.seriesId,
          gameNumber: index + 1,
        })),
        fixture.identity.tournamentSeed
      ));
    }

    const r8 = buildNextKnockoutRound(initialRound, evaluations);
    const earlyR8Record = acceptedKnockoutRecord(
      r8.series[0],
      1,
      fixture.identity,
      'tie'
    );
    const persistedOrder = [...r16Records];
    persistedOrder.splice(
      persistedOrder.length - 1,
      0,
      earlyR8Record
    );

    await assert.rejects(
      replan(fixture, persistedOrder),
      /r8-series-01-game-01.*before the r16 completion barrier/i
    );
  });

  await t.test('unknown series', async t => {
    const fixture = await transitionedTournament(t, runIdentity({
      runId: 'knockout-unknown-series',
    }));
    const request = generateKnockoutSeriesGame(
      fixture.plan.rounds[0].series[0],
      1,
      fixture.identity.tournamentSeed
    );
    const record = acceptedRecord(request, fixture.identity, {
      matchId: 'r16-series-09-game-01',
    });

    await assert.rejects(
      replan(fixture, [record]),
      /unknown knockout series.*r16-series-09/i
    );
  });

  await t.test('game after completion', async t => {
    const fixture = await transitionedTournament(t, runIdentity({
      runId: 'knockout-after-complete',
    }));
    const series = fixture.plan.rounds[0].series[0];
    const records = [
      ...completedSeriesRecords(series, fixture.identity),
      acceptedKnockoutRecord(series, 3, fixture.identity, 'tie'),
    ];

    await assert.rejects(
      replan(fixture, records),
      /after the series was complete/i
    );
  });

  await t.test('pinned simulator version', async t => {
    const fixture = await transitionedTournament(t, runIdentity({
      runId: 'knockout-version-conflict',
    }));
    const series = fixture.plan.rounds[0].series[0];
    const record = acceptedKnockoutRecord(
      series,
      1,
      fixture.identity,
      'tie',
      {simulatorVersion: 'pokemon-showdown@9.9.9'}
    );

    await assert.rejects(
      replan(fixture, [record]),
      /simulatorVersion.*pinned version/i
    );
  });
});

test('a result-complete r2 derives the champion and awaits persistence', async t => {
  const fixture = await transitionedTournament(t);
  const records = [];
  let round = fixture.plan.rounds[0];
  let finalRound;

  while (true) {
    const evaluations = round.series.map(series => {
      const seriesRecords = completedSeriesRecords(
        series,
        fixture.identity
      );
      records.push(...seriesRecords);
      return evaluateKnockoutSeries(
        series,
        seriesRecords.map((record, index) => ({
          ...record,
          seriesId: series.seriesId,
          gameNumber: index + 1,
        })),
        fixture.identity.tournamentSeed
      );
    });

    if (round.round === 'r2') {
      finalRound = round;
      break;
    }

    round = buildNextKnockoutRound(round, evaluations);
  }

  const plan = await replan(fixture, records);

  assert.equal(plan.stage, 'knockout');
  assert.equal(plan.activeRound, 'r2');
  assert.equal(plan.tournamentComplete, false);
  assert.equal(plan.resultComplete, true);
  assert.deepEqual(plan.rounds.map(entry => entry.round), [
    'r16', 'r8', 'r4', 'r2',
  ]);
  assert.deepEqual(
    plan.champion.champion,
    finalRound.series[0].entrant1
  );
  assert.equal(plan.champion.resolution, 'two-wins');
  assert.equal(plan.completedSeriesEvaluations.length, 15);
  assert.deepEqual(plan.nextGameRequests, []);
  assert.equal(plan.acceptedKnockoutResultCount, 30);
  assert.equal(plan.acceptedResultCount, 142);
});

test('knockout planning preserves supplied state and derived artifacts', async t => {
  const fixture = await transitionedTournament(t);
  const series = fixture.plan.rounds[0].series[0];
  const acceptedRecords = [
    ...fixture.groupRecords,
    acceptedKnockoutRecord(series, 1, fixture.identity, 'tie'),
  ];
  const runState = {
    runDirectory: fixture.runDirectory,
    metadata: structuredClone(fixture.groupPlan.metadata),
    checkpointHint: checkpoint({
      round: 'r2',
      schedulePosition: 400,
      acceptedResultCount: 2,
    }),
    acceptedRecords,
    completedMatches: new Map(acceptedRecords.map(record => [
      record.matchId,
      record,
    ])),
    roster: JSON.parse(await readFile(
      join(fixture.runDirectory, 'roster.json'),
      'utf8'
    )),
    standings: structuredClone(fixture.plan.finalStandings),
    bracket: {rounds: structuredClone(fixture.plan.rounds)},
    resumed: true,
    terminal: false,
  };
  const stateSnapshot = structuredClone(runState);
  const identitySnapshot = structuredClone(fixture.identity);

  const plan = buildKnockoutRecoveryPlan(runState, fixture.identity);

  assert.equal(plan.activeRound, 'r16');
  assert.deepEqual(runState, stateSnapshot);
  assert.deepEqual(fixture.identity, identitySnapshot);
});

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
