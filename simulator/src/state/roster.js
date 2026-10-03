'use strict';

const {join} = require('node:path');
const {isDeepStrictEqual} = require('node:util');
const {requireObject, validateRunIdentity, requireNonEmptyString, validateRunRoster} = require('./contracts');
const {readJsonFile, atomicCreateJson} = require('./json-files');

async function loadOrCreateRunRoster(options) {
  requireObject(options, 'Run roster options');
  validateRunIdentity(options.identity);
  requireNonEmptyString(options.runDirectory, 'runDirectory');
  const rosterPath = join(options.runDirectory, 'roster.json');
  let existing = await readJsonFile(rosterPath, 'run roster JSON');

  if (existing !== undefined) {
    validateRunRoster(existing, options.identity);

    if (options.roster !== undefined &&
        !isDeepStrictEqual(existing, options.roster)) {
      throw new Error('Persisted run roster conflicts with the requested roster');
    }

    return {created: false, roster: existing};
  }

  if (options.roster === undefined) {
    return {created: false, roster: undefined};
  }

  validateRunRoster(options.roster, options.identity);

  try {
    await atomicCreateJson(rosterPath, options.roster);
    return {created: true, roster: options.roster};
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  existing = await readJsonFile(rosterPath, 'run roster JSON');
  validateRunRoster(existing, options.identity);

  if (!isDeepStrictEqual(existing, options.roster)) {
    throw new Error('Persisted run roster conflicts with the requested roster');
  }

  return {created: false, roster: existing};
}

module.exports = {
  loadOrCreateRunRoster,
};
