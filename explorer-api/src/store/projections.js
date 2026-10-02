'use strict';

const {projectReportFacts} = require('../report-projection');
function toSummary(artifacts) {
  return {
    runId: artifacts.metadata.runId,
    mode: artifacts.metadata.mode,
    status: artifacts.metadata.status,
    startedAt: artifacts.metadata.startedAt,
    completedAt: artifacts.metadata.completedAt,
    tournamentSeed: artifacts.metadata.tournamentSeed,
    rulesVersion: artifacts.metadata.rulesVersion,
    simulatorVersion: artifacts.metadata.simulatorVersion,
    simulatorImage: artifacts.metadata.simulatorImage,
    runnerConcurrency: artifacts.metadata.runnerConcurrency,
    entrantCount: artifacts.roster.entrants.length,
    matchCount: artifacts.uniqueResultCount,
    failureCount: artifacts.failures.length,
    champion: artifacts.champion.champion,
    hasReport: artifacts.hasReport,
  };
}

function toRunDetail(artifacts) {
  return {
    ...toSummary(artifacts),
    rosterHash: artifacts.roster.rosterHash,
    rosterHashVerified: artifacts.rosterHashVerified,
    duplicateMatchIdCount: artifacts.duplicateMatchIdCount,
    checkpoint: artifacts.checkpoint,
    report: {...(artifacts.reportFacts ||= projectReportFacts(artifacts)), generatedAt: new Date().toISOString()},
  };
}
module.exports = {toSummary, toRunDetail};
