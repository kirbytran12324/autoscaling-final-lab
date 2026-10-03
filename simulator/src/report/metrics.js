'use strict';

const {percentile} = require('./formatters');

function operationalStats(results, failures, metadata) {
  const durations = results.map(result => result.durationMs).sort((a, b) => a - b);
  const slowest = [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
  return {
    wallClockMs: Date.parse(metadata.completedAt) - Date.parse(metadata.startedAt),
    durations: {
      min: durations[0], median: percentile(durations, 0.5),
      p95: percentile(durations, 0.95), p99: percentile(durations, 0.99),
      max: durations.at(-1),
      mean: durations.reduce((sum, value) => sum + value, 0) / durations.length,
    },
    wins: results.filter(result => result.outcome === 'win').length,
    draws: results.filter(result => result.outcome === 'tie').length,
    turnCaps: results.filter(result => result.termination === 'turn-cap').length,
    terminalFailures: failures.length,
    slowest,
  };
}

module.exports = {operationalStats};
