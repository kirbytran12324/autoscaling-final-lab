'use strict';



const GROUP_NAMES = Object.freeze(['A', 'B', 'C', 'D']);

const REQUIRED_FILES = Object.freeze([
  'run-metadata.json',
  'roster.json',
  'results.jsonl',
  'checkpoint.json',
  'standings.json',
  'bracket.json',
]);

module.exports = {GROUP_NAMES, REQUIRED_FILES};
