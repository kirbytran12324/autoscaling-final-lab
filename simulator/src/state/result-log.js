'use strict';

const {createReadStream} = require('node:fs');

const {open} = require('node:fs/promises');
const {haveSameDeterministicResult} = require('../deterministic-result');
const {DETERMINISTIC_RESULT_FIELDS} = require('./constants');
const {serializeJsonLine} = require('./json-files');

function buildCompletedMatchIndex(records) {
  if (!Array.isArray(records)) {
    throw new TypeError('Completed match records must be an array');
  }

  const completedMatches = new Map();

  for (const [index, record] of records.entries()) {
    if (record === null || typeof record !== 'object' ||
        Array.isArray(record)) {
      throw new TypeError(
        `Completed match record at index ${index} must be a non-array object`
      );
    }

    for (const field of DETERMINISTIC_RESULT_FIELDS) {
      if (!Object.hasOwn(record, field)) {
        throw new TypeError(
          `Completed match record at index ${index} is missing ` +
            `deterministic field "${field}"`
        );
      }
    }

    if (typeof record.matchId !== 'string' || record.matchId.trim() === '') {
      throw new TypeError(
        `Completed match record at index ${index} must have a non-empty ` +
          'string matchId'
      );
    }

    const previousRecord = completedMatches.get(record.matchId);

    if (previousRecord === undefined) {
      completedMatches.set(record.matchId, record);
    } else if (!haveSameDeterministicResult(previousRecord, record)) {
      throw new Error(
        `Reproducibility conflict for matchId "${record.matchId}": ` +
          'deterministic result fields differ'
      );
    }
  }

  return completedMatches;
}

async function appendJsonLine(filePath, value) {
  const serialized = serializeJsonLine(value);
  let file;

  try {
    file = await open(filePath, 'a');
    await file.writeFile(serialized, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
  } catch (error) {
    if (file !== undefined) {
      try {
        await file.close();
      } catch {
        // Preserve the error that interrupted the durable append.
      }
    }

    throw error;
  }
}

async function readJsonLines(filePath, {required = false} = {}) {
  const records = [];
  let pending = '';
  let lineNumber = 0;
  try {
    // Bound temporary text to a stream chunk plus one record, rather than the
    // entire result log. Returned canonical records preserve the public API.
    for await (const chunk of createReadStream(filePath, {encoding: 'utf8'})) {
      pending += chunk;
      let start = 0;
      let newline;
      while ((newline = pending.indexOf('\n', start)) !== -1) {
        const line = pending.slice(start, newline);
        lineNumber++;
        if (line.trim() === '') {
          throw new Error(`Blank JSON Lines record on line ${lineNumber}`);
        }
        try { records.push(JSON.parse(line)); }
        catch (error) {
          throw new SyntaxError(`Malformed JSON on line ${lineNumber}: ${error.message}`, {cause: error});
        }
        start = newline + 1;
      }
      pending = pending.slice(start);
    }
  } catch (error) {
    if (error.code === 'ENOENT' && !required) return [];
    throw error;
  }
  if (pending !== '') {
    throw new Error(`JSON Lines record on line ${lineNumber + 1} lacks a terminating newline`);
  }
  return records;
}

module.exports = {
  haveSameDeterministicResult,
  buildCompletedMatchIndex,
  appendJsonLine,
  readJsonLines,
};
