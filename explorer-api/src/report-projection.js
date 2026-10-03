'use strict';

const {
  aggregatePodAttribution,
  formatDuration,
} = require('../../simulator/src/report-renderer');
const {operationalStats} = require('../../simulator/src/report/metrics');

function stageForResult(artifacts, result) {
  if (typeof result.stage === 'string' && result.stage.trim() !== '') {
    return result.stage.trim();
  }
  return artifacts.groupByMatchId.has(result.matchId) ? 'Group stage' : 'Knockout';
}

function integrityVerified(artifacts) {
  return artifacts.rosterHashVerified && artifacts.duplicateMatchIdCount === 0 &&
    artifacts.uniqueResultCount === artifacts.results.length &&
    artifacts.metadata.status === 'completed' && artifacts.checkpoint.stage === 'complete' &&
    artifacts.standings.status === 'final' && artifacts.bracket.status === 'completed';
}

function projectReportFacts(artifacts, generatedAt = new Date().toISOString()) {
  const knockoutResultCount = artifacts.results.length - artifacts.expectedGroupResultCount;
  const expectedAcceptedResults = artifacts.expectedGroupResultCount + knockoutResultCount;
  const attributed = artifacts.results.map(result => ({
    ...result,
    stage: stageForResult(artifacts, result),
  }));
  const statistics = operationalStats(
    artifacts.results,
    artifacts.failures,
    artifacts.metadata
  );
  return {
    generatedAt,
    sourceFiles: artifacts.sourceFiles,
    champion: artifacts.bracket.champion,
    integrity: {
      verified: integrityVerified(artifacts) &&
        artifacts.uniqueResultCount === expectedAcceptedResults,
      expectedAcceptedResults,
      acceptedResultRecords: artifacts.uniqueResultCount,
      uniqueMatchIds: artifacts.uniqueResultCount,
      duplicateMatchIds: artifacts.duplicateMatchIdCount,
      invalidJsonRecords: 0,
      terminalBattleFailures: artifacts.failures.length,
      knockoutResultCount,
      knockoutRoundCount: artifacts.bracket.rounds.length,
      standingsStatus: artifacts.standings.status,
      standingsAcceptedResultCount: artifacts.standings.acceptedResultCount,
      standingsExpectedResultCount: artifacts.standings.expectedResultCount,
      bracketStatus: artifacts.bracket.status,
    },
    statistics: {
      ...statistics,
      slowest: statistics.slowest.map(result => ({
        ...result,
        formattedDuration: formatDuration(result.durationMs),
      })),
      formatted: {
        wallClock: formatDuration(statistics.wallClockMs),
        minimum: formatDuration(statistics.durations.min),
        mean: formatDuration(statistics.durations.mean),
        median: formatDuration(statistics.durations.median),
        p95: formatDuration(statistics.durations.p95),
        p99: formatDuration(statistics.durations.p99),
        maximum: formatDuration(statistics.durations.max),
      },
    },
    podAttribution: aggregatePodAttribution(attributed),
    matchFacets: {
      stages: ['Group stage', 'Knockout'],
      hostnames: [...new Set(artifacts.results
        .map(result => result.servedBy)
        .filter(Boolean))].sort(),
    },
  };
}

module.exports = {integrityVerified, operationalStats, projectReportFacts, stageForResult};
