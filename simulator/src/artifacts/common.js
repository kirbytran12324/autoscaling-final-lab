'use strict';



function requireObject(value, description) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${description} must be a non-array object`);
  }
}

function requireTimestamp(value, description) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${description} must be a valid timestamp`);
  }
}

function identityFromMetadata(metadata) {
  return {
    runId: metadata.runId,
    mode: metadata.mode,
    tournamentSeed: metadata.tournamentSeed,
    rulesVersion: metadata.rulesVersion,
    simulatorVersion: metadata.simulatorVersion,
    simulatorImage: metadata.simulatorImage,
    runnerConcurrency: metadata.runnerConcurrency,
  };
}

function speciesFromRoster(roster) {
  return roster.entrants.map(entrant => ({
    id: entrant.speciesId,
    name: entrant.species,
    num: entrant.nationalDexNumber,
  }));
}

module.exports = {requireObject, requireTimestamp, identityFromMetadata, speciesFromRoster};
