'use strict';

// Compatibility entry point for the offline report.
module.exports = {
  REQUIRED_FILES: require('./artifacts/constants').REQUIRED_FILES,
  loadTournamentArtifacts: require('./artifacts/loader').loadTournamentArtifacts,
};
