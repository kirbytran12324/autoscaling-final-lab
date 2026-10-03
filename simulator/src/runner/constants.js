'use strict';



const GROUP_NAMES = Object.freeze(['A', 'B', 'C', 'D']);

const PROVISIONAL_CADENCE = Object.freeze({
  sample: 10,
  full: 1000,
});

const KNOCKOUT_MATCH_ID_PATTERN =
  /^(r\d+)-series-(\d{2})-game-(\d{2})$/;

module.exports = {
  GROUP_NAMES,
  PROVISIONAL_CADENCE,
  KNOCKOUT_MATCH_ID_PATTERN,
};
