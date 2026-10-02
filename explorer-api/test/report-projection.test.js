'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');

const {loadTournamentArtifacts} = require('../../simulator/src/report-loader');
const {renderReport} = require('../../simulator/src/report-renderer');
const {projectReportFacts, stageForResult} = require('../src/report-projection');
const {FIXTURE_RUN_ID, createFixtureRoot, removeFixtureRoot} = require('./helpers');

test('shared operational statistics stay characterized against the offline renderer', async t => {
  const root = await createFixtureRoot();
  t.after(() => removeFixtureRoot(root));
  const artifacts = await loadTournamentArtifacts({stateRoot: root, runId: FIXTURE_RUN_ID});
  const generatedAt = '2026-09-30T00:00:00.000Z';
  const facts = projectReportFacts(artifacts, generatedAt);
  const report = renderReport(artifacts, {generatedAt});

  for (const [label, value] of [
    ['Wins', facts.statistics.wins],
    ['Draws', facts.statistics.draws],
    ['Turn-cap terminations', facts.statistics.turnCaps],
    ['Mean battle duration', facts.statistics.formatted.mean],
    ['p99 battle duration', facts.statistics.formatted.p99],
  ]) {
    assert.ok(report.includes(`<span>${label}</span><strong>${value}</strong>`), label);
  }
  assert.equal(facts.podAttribution.totalAcceptedCount, artifacts.results.length);
});

test('stage projection preserves a recorded stage before inferring a fallback', () => {
  const artifacts = {groupByMatchId: new Map([['group-match', 'A']])};
  assert.equal(stageForResult(artifacts, {
    matchId: 'group-match', stage: '  Recorded stage  ',
  }), 'Recorded stage');
  assert.equal(stageForResult(artifacts, {matchId: 'group-match'}), 'Group stage');
  assert.equal(stageForResult(artifacts, {matchId: 'knockout-match'}), 'Knockout');
});
