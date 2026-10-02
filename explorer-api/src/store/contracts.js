'use strict';

const {ArtifactStoreError} = require('../errors');
const RUN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,199}$/;
const REPORT_FILE = 'report.html';
const OPTIONAL_FILES = Object.freeze(['failures.jsonl', REPORT_FILE]);
const MATCH_SORTS = Object.freeze(['matchId', 'stage', 'matchup', 'result', 'winner', 'turns']);
const SORT_DIRECTIONS = Object.freeze(['asc', 'desc']);
const collator = new Intl.Collator('en-US', {numeric: true});
function validateRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new ArtifactStoreError(
      400,
      'INVALID_RUN_ID',
      'Run ID must be a lowercase DNS-style name of at most 63 characters.'
    );
  }
  return runId;
}

function validateMatchId(matchId) {
  if (typeof matchId !== 'string' || !MATCH_ID_PATTERN.test(matchId)) {
    throw new ArtifactStoreError(400, 'INVALID_MATCH_ID', 'Match ID is invalid.');
  }
  return matchId;
}
module.exports = {RUN_ID_PATTERN, MATCH_ID_PATTERN, REPORT_FILE, OPTIONAL_FILES, MATCH_SORTS, SORT_DIRECTIONS, collator, validateRunId, validateMatchId};
