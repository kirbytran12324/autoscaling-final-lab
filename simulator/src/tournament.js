'use strict';

// Compatibility entry point. Implementations live in purpose-specific modules.
module.exports = {
  SAMPLE_GROUP_SIZES: require('./tournament/rules').SAMPLE_GROUP_SIZES,
  FULL_GROUP_SIZES: require('./tournament/rules').FULL_GROUP_SIZES,
  SAMPLE_ADVANCERS_PER_GROUP: require('./tournament/rules').SAMPLE_ADVANCERS_PER_GROUP,
  FULL_ADVANCERS_PER_GROUP: require('./tournament/rules').FULL_ADVANCERS_PER_GROUP,
  NEXT_KNOCKOUT_ROUND: require('./tournament/rules').NEXT_KNOCKOUT_ROUND,
  KNOCKOUT_SERIES_COUNTS: require('./tournament/rules').KNOCKOUT_SERIES_COUNTS,
  deriveShowdownSeed: require('./tournament/seeding').deriveShowdownSeed,
  buildSampleRoster: require('./tournament/roster').buildSampleRoster,
  buildFullRoster: require('./tournament/roster').buildFullRoster,
  selectTournamentRoster: require('./tournament/roster').selectTournamentRoster,
  shuffleRoster: require('./tournament/roster').shuffleRoster,
  splitRosterIntoGroups: require('./tournament/roster').splitRosterIntoGroups,
  generateGroupStageSchedule: require('./tournament/schedule').generateGroupStageSchedule,
  calculateGroupRecords: require('./tournament/standings').calculateGroupRecords,
  calculateGroupStandings: require('./tournament/standings').calculateGroupStandings,
  selectAdvancers: require('./tournament/standings').selectAdvancers,
  buildInitialKnockoutRound: require('./tournament/bracket').buildInitialKnockoutRound,
  buildNextKnockoutRound: require('./tournament/bracket').buildNextKnockoutRound,
  generateKnockoutSeriesGame: require('./tournament/series').generateKnockoutSeriesGame,
  evaluateKnockoutSeries: require('./tournament/series').evaluateKnockoutSeries,
  selectTournamentChampion: require('./tournament/series').selectTournamentChampion,
};
