'use strict';

const {getBaseSpecies} = require('../catalog');
const {calculateRosterHash, validateRunRoster} = require('../runner-state');

function buildRunRoster(identity, rosterSeed, shuffledRoster) {
  const roster = {
    schemaVersion: 1,
    runId: identity.runId,
    mode: identity.mode,
    tournamentSeed: identity.tournamentSeed,
    rosterSeed: [...rosterSeed],
    entrants: shuffledRoster.map((species, index) => ({
      position: index + 1,
      nationalDexNumber: species.num,
      speciesId: species.id,
      species: species.name,
    })),
  };
  roster.rosterHash = calculateRosterHash(roster);
  validateRunRoster(roster, identity);
  return roster;
}

function loadRosterSpecies(roster, identity) {
  validateRunRoster(roster, identity);

  return roster.entrants.map((entrant, index) => {
    const species = getBaseSpecies(entrant.species);

    if (species.id !== entrant.speciesId ||
        species.num !== entrant.nationalDexNumber) {
      throw new Error(
        `Run roster entrant ${index + 1} conflicts with the pinned catalog`
      );
    }

    return species;
  });
}

module.exports = {
  buildRunRoster,
  loadRosterSpecies,
};
