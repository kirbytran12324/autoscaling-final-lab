'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createSimulatorClient,
  validateBattleResult,
} = require('../src/simulator-client');

const SIMULATOR_VERSION = 'pokemon-showdown@0.11.11';

function battleRequest(overrides = {}) {
  return {
    matchId: 'group-A-000001',
    pokemon1: 'Snorlax',
    pokemon2: 'Clefable',
    seed: [12345, 23456, 34567, 45678],
    maxTurns: 100,
    ...overrides,
  };
}

function battleResult(overrides = {}) {
  return {
    matchId: 'group-A-000001',
    pokemon1: 'Snorlax',
    pokemon2: 'Clefable',
    seed: [12345, 23456, 34567, 45678],
    simulatorVersion: SIMULATOR_VERSION,
    outcome: 'win',
    winnerSide: 'p1',
    winnerSpecies: 'Snorlax',
    turns: 42,
    termination: 'natural',
    protocolHash: 'a'.repeat(64),
    servedBy: 'simulator-1',
    durationMs: 12.5,
    ...overrides,
  };
}

function jsonResponse(result) {
  return {
    ok: true,
    status: 200,
    async json() {
      return result;
    },
  };
}

function clientOptions(overrides = {}) {
  return {
    baseUrl: 'http://simulator.default.svc:3000',
    expectedSimulatorVersion: SIMULATOR_VERSION,
    sleepImpl: async () => {},
    ...overrides,
  };
}

module.exports = {
  SIMULATOR_VERSION,
  battleRequest,
  battleResult,
  jsonResponse,
  clientOptions
};
