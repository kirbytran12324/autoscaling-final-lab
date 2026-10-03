'use strict';



const SAMPLE_GROUP_SIZES = Object.freeze([8, 8, 8, 8]);

const FULL_GROUP_SIZES = Object.freeze([257, 256, 256, 256]);

const SAMPLE_ADVANCERS_PER_GROUP = 4;

const FULL_ADVANCERS_PER_GROUP = 16;

const GROUP_NAMES = Object.freeze(['A', 'B', 'C', 'D']);

const NEXT_KNOCKOUT_ROUND = Object.freeze({
  r64: 'r32',
  r32: 'r16',
  r16: 'r8',
  r8: 'r4',
  r4: 'r2',
});

const KNOCKOUT_SERIES_COUNTS = Object.freeze({
  r64: 32,
  r32: 16,
  r16: 8,
  r8: 4,
  r4: 2,
  r2: 1,
});

module.exports = {
  SAMPLE_GROUP_SIZES,
  FULL_GROUP_SIZES,
  SAMPLE_ADVANCERS_PER_GROUP,
  FULL_ADVANCERS_PER_GROUP,
  GROUP_NAMES,
  NEXT_KNOCKOUT_ROUND,
  KNOCKOUT_SERIES_COUNTS,
};
