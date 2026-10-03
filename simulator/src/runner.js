'use strict';

// Compatibility entry point. Implementations live in purpose-specific modules.
module.exports = {
  buildGroupStageRecoveryPlan: require('./runner/group-recovery').buildGroupStageRecoveryPlan,
  buildGroupStandingsArtifact: require('./runner/group-artifacts').buildGroupStandingsArtifact,
  buildInitialKnockoutArtifact: require('./runner/group-artifacts').buildInitialKnockoutArtifact,
  buildKnockoutRecoveryPlan: require('./runner/knockout-recovery').buildKnockoutRecoveryPlan,
  executeGroupStagePlan: require('./runner/group-executor').executeGroupStagePlan,
  executeKnockoutPlan: require('./runner/knockout-executor').executeKnockoutPlan,
  planTournamentRun: require('./runner/orchestrator').planTournamentRun,
  runTournament: require('./runner/orchestrator').runTournament,
};
