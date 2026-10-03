'use strict';

// Compatibility entry point. Implementations live in purpose-specific modules.
module.exports = {
  appendJsonLine: require('./state/result-log').appendJsonLine,
  calculateRosterHash: require('./state/contracts').calculateRosterHash,
  atomicWriteJson: require('./state/json-files').atomicWriteJson,
  buildCompletedMatchIndex: require('./state/result-log').buildCompletedMatchIndex,
  initializeOrResumeRun: require('./state/lifecycle').initializeOrResumeRun,
  loadOrCreateRunRoster: require('./state/roster').loadOrCreateRunRoster,
  readJsonLines: require('./state/result-log').readJsonLines,
  resolveRunDirectory: require('./state/contracts').resolveRunDirectory,
  validateCheckpoint: require('./state/contracts').validateCheckpoint,
  validateRunMetadata: require('./state/contracts').validateRunMetadata,
  validateRunRoster: require('./state/contracts').validateRunRoster,
};
