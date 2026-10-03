'use strict';

const {readFile} = require('node:fs/promises');
const {join} = require('node:path');
const {readJsonLines} = require('../runner-state');
const {validateFailureRecords} = require('./failures');

async function readRequiredJson(runDirectory, fileName) {
  let contents;

  try {
    contents = await readFile(join(runDirectory, fileName), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Required tournament artifact ${fileName} is missing`);
    }
    throw error;
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new SyntaxError(
      `Malformed tournament artifact ${fileName}: ${error.message}`,
      {cause: error}
    );
  }
}

async function readRequiredJsonLines(runDirectory, fileName) {
  try {
    return await readJsonLines(join(runDirectory, fileName), {required: true});
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Required tournament artifact ${fileName} is missing`, {cause: error});
    }
    throw new Error(`Malformed tournament artifact ${fileName}: ${error.message}`, {cause: error});
  }
}

async function readOptionalFailures(runDirectory, runId) {
  let records;
  try {
    records = await readJsonLines(join(runDirectory, 'failures.jsonl'));
  } catch (error) {
    throw new Error(`Malformed tournament artifact failures.jsonl: ${error.message}`, {
      cause: error,
    });
  }
  validateFailureRecords(records, runId);
  return records;
}

module.exports = {readRequiredJson, readRequiredJsonLines, readOptionalFailures};
