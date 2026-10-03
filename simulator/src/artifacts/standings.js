'use strict';

const {isDeepStrictEqual} = require('node:util');
const {FULL_ADVANCERS_PER_GROUP, SAMPLE_ADVANCERS_PER_GROUP, calculateGroupStandings} = require('../tournament');
const {requireObject, requireTimestamp} = require('./common');
const {GROUP_NAMES} = require('./constants');

function validateStandings(standings, metadata, groups, groupRecords) {
  requireObject(standings, 'standings.json');
  requireTimestamp(standings.updatedAt, 'standings.json updatedAt');
  const advancingCount = metadata.mode === 'sample'
    ? SAMPLE_ADVANCERS_PER_GROUP
    : FULL_ADVANCERS_PER_GROUP;
  const calculatedGroups = GROUP_NAMES.map(group =>
    calculateGroupStandings(
      group,
      groups[group],
      groupRecords.get(group),
      metadata.tournamentSeed
    )
  );
  const expectedCount = calculatedGroups.reduce(
    (total, group) => total + group.expectedMatches,
    0
  );

  if (standings.schemaVersion !== 1 || standings.runId !== metadata.runId ||
      standings.status !== 'final' ||
      standings.acceptedResultCount !== expectedCount ||
      standings.expectedResultCount !== expectedCount ||
      standings.advancingCount !== advancingCount ||
      !isDeepStrictEqual(standings.groups, calculatedGroups)) {
    throw new Error(
      'standings.json conflicts with the completed authoritative group results'
    );
  }

  return {advancingCount, calculatedGroups, expectedCount};
}

module.exports = {validateStandings};
