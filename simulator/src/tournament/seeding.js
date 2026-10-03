'use strict';

const {createHash} = require('node:crypto');

function deriveTournamentDigest(tournamentSeed, identifier) {
  return createHash('sha256')
    .update(`${tournamentSeed}\n${identifier}`, 'utf8')
    .digest();
}

function showdownSeedFromDigest(digest) {
  return [0, 2, 4, 6].map(offset =>
    digest.readUInt16BE(offset)
  );
}

function deriveShowdownSeed(tournamentSeed, identifier) {
  const digest = deriveTournamentDigest(tournamentSeed, identifier);
  return showdownSeedFromDigest(digest);
}

module.exports = {
  deriveTournamentDigest,
  showdownSeedFromDigest,
  deriveShowdownSeed,
};
