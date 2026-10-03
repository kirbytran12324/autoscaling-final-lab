'use strict';



const {DETERMINISTIC_RESULT_FIELDS} = require('../deterministic-result');

const RUN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const RUN_IDENTITY_FIELDS = Object.freeze([
  'runId',
  'mode',
  'tournamentSeed',
  'rulesVersion',
  'simulatorVersion',
  'simulatorImage',
  'runnerConcurrency',
]);

const RUN_STATUSES = new Set(['running', 'completed', 'failed']);

const CHECKPOINT_STAGES = new Set(['groups', 'knockout', 'complete']);

const ROSTER_COUNTS = Object.freeze({sample: 32, full: 1025});

const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-' +
  '[0-9a-f]{12}';

const METADATA_TEMPORARY_FILE_PATTERN = new RegExp(
  `^\\.run-metadata\\.json\\.[1-9]\\d*\\.${UUID_PATTERN}\\.tmp$`
);

module.exports = {
  DETERMINISTIC_RESULT_FIELDS,
  RUN_ID_PATTERN,
  RUN_IDENTITY_FIELDS,
  RUN_STATUSES,
  CHECKPOINT_STAGES,
  ROSTER_COUNTS,
  UUID_PATTERN,
  METADATA_TEMPORARY_FILE_PATTERN,
};
