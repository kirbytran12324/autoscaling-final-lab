'use strict';
const {RunCache} = require('./store/cache');
const catalog = require('./store/catalog');
const standings = require('./store/standings');
const matches = require('./store/matches');
const reports = require('./store/reports');
const {MATCH_SORTS, MATCH_ID_PATTERN, RUN_ID_PATTERN, SORT_DIRECTIONS, validateMatchId, validateRunId} = require('./store/contracts');
const {encodeCursor, decodeCursor} = require('./store/cursors');

class FilesystemArtifactStore extends RunCache {
  async listRuns(...args) { return catalog.listRuns.apply(this, args); }
  async getRun(...args) { return catalog.getRun.apply(this, args); }
  async getBracket(...args) { return catalog.getBracket.apply(this, args); }
  async getStandings(...args) { return standings.getStandings.apply(this, args); }
  async listMatches(...args) { return matches.listMatches.apply(this, args); }
  async getMatch(...args) { return matches.getMatch.apply(this, args); }
  async getReplayContext(...args) { return matches.getReplayContext.apply(this, args); }
  async getReport(...args) { return reports.getReport.apply(this, args); }
}
module.exports = {FilesystemArtifactStore, MATCH_SORTS, MATCH_ID_PATTERN, RUN_ID_PATTERN,
  SORT_DIRECTIONS, decodeCursor, encodeCursor, validateMatchId, validateRunId};
