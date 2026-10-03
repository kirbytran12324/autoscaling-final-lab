'use strict';

// Compatibility entry point for the offline report.
module.exports = {
  MAX_DYNAMIC_STAGE_COLUMNS: require('./report/constants').MAX_DYNAMIC_STAGE_COLUMNS,
  PAGE_SIZE: require('./report/constants').SIMULATION_PAGE_SIZE,
  PAGE_SIZE_OPTIONS: require('./report/constants').PAGE_SIZE_OPTIONS,
  SIMULATION_PAGE_SIZE: require('./report/constants').SIMULATION_PAGE_SIZE,
  STANDINGS_PAGE_SIZE: require('./report/constants').STANDINGS_PAGE_SIZE,
  aggregatePodAttribution: require('./report/attribution').aggregatePodAttribution,
  deriveSharedHostnamePrefix: require('./report/attribution').deriveSharedHostnamePrefix,
  escapeHtml: require('./report/formatters').escapeHtml,
  formatDuration: require('./report/formatters').formatDuration,
  formatNumber: require('./report/formatters').formatNumber,
  paginateStandings: require('./report/standings').paginateStandings,
  paginateRows: require('./report/ui').paginateRows,
  renderPodAttribution: require('./report/attribution').renderPodAttribution,
  renderReport: require('./report/renderer').renderReport,
  roundCounts: require('./report/bracket').roundCounts,
};
