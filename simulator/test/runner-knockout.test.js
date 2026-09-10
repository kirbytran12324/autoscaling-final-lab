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
  planTournamentRun,
} = require('../src/runner');
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

test('a completed r2 derives the deterministic champion', async t => {
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

  assert.equal(plan.stage, 'complete');
  assert.equal(plan.activeRound, null);
  assert.equal(plan.tournamentComplete, true);
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
