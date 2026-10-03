'use strict';

const SIMULATION_PAGE_SIZE = 25;

const STANDINGS_PAGE_SIZE = 25;

const PAGE_SIZE_OPTIONS = Object.freeze([25, 50, 100]);

const MAX_DYNAMIC_STAGE_COLUMNS = 4;

const SIMULATION_COLUMNS = Object.freeze([
  'matchId', 'stage', 'group', 'round', 'pokemon1', 'pokemon2', 'result',
  'winnerSide', 'winner', 'turns', 'termination', 'servedBy', 'durationMs', 'seed',
  'protocolHash',
]);

module.exports = {SIMULATION_PAGE_SIZE, STANDINGS_PAGE_SIZE, PAGE_SIZE_OPTIONS, MAX_DYNAMIC_STAGE_COLUMNS, SIMULATION_COLUMNS};
