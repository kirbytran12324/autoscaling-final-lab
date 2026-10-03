'use strict';

const {isDeepStrictEqual} = require('node:util');

const DETERMINISTIC_RESULT_FIELDS = Object.freeze([
  'matchId', 'pokemon1', 'pokemon2', 'seed', 'simulatorVersion',
  'outcome', 'winnerSide', 'winnerSpecies', 'turns', 'termination', 'protocolHash',
]);

function haveSameDeterministicResult(left, right) {
  return DETERMINISTIC_RESULT_FIELDS.every(field => isDeepStrictEqual(left[field], right[field]));
}

module.exports = {DETERMINISTIC_RESULT_FIELDS, haveSameDeterministicResult};
