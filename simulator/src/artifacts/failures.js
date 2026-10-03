'use strict';

const {requireObject, requireTimestamp} = require('./common');

function validateFailureRecords(records, runId) {
  for (const [index, record] of records.entries()) {
    requireObject(record, `failures.jsonl record ${index + 1}`);
    requireObject(record.request, `failures.jsonl record ${index + 1} request`);
    requireObject(record.error, `failures.jsonl record ${index + 1} error`);
    requireTimestamp(record.failedAt, `failures.jsonl record ${index + 1} failedAt`);
    if (record.schemaVersion !== 1 ||
        typeof record.matchId !== 'string' || record.matchId === '' ||
        record.runId !== runId) {
      throw new Error(
        `failures.jsonl record ${index + 1} is invalid or conflicts with run ID ${runId}`
      );
    }
  }
}

module.exports = {validateFailureRecords};
