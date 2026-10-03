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

module.exports = {
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
};
