'use strict';

const assert = require('node:assert/strict');
const {once} = require('node:events');
const {after, before, test} = require('node:test');

const {createServer} = require('../src/server');

let server;
let baseUrl;

before(async () => {
  server = createServer();

  // Port 0 asks the operating system for an available test port.
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
});

test('liveness and readiness endpoints report healthy', async () => {
  const liveResponse = await fetch(`${baseUrl}/health/live`);
  const readyResponse = await fetch(`${baseUrl}/health/ready`);

  assert.equal(liveResponse.status, 200);
  assert.deepEqual(await liveResponse.json(), {
    status: 'ok',
  });

  assert.equal(readyResponse.status, 200);
  assert.deepEqual(await readyResponse.json(), {
    status: 'ready',
    speciesCount: 1025,
    metronomeMoveCount: 581,
  });
});

test('POST /v1/battles returns a battle result', async () => {
  const response = await fetch(`${baseUrl}/v1/battles`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      matchId: 'group-001',
      pokemon1: 'Snorlax',
      pokemon2: 'Clefable',
      seed: [12345, 23456, 34567, 45678],
      maxTurns: 100,
    }),
  });

  assert.equal(response.status, 200);

  const result = await response.json();

  assert.equal(result.matchId, 'group-001');
  assert.equal(result.outcome, 'win');
  assert.equal(result.winnerSide, 'p1');
  assert.equal(result.winnerSpecies, 'Snorlax');
  assert.match(result.protocolHash, /^[a-f0-9]{64}$/);
  assert.equal(typeof result.servedBy, 'string');
  assert.equal(typeof result.durationMs, 'number');
});

test('invalid species returns a controlled client error', async () => {
  const response = await fetch(`${baseUrl}/v1/battles`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      matchId: 'bad-001',
      pokemon1: 'MissingNo',
      pokemon2: 'Clefable',
      seed: [1, 2, 3, 4],
    }),
  });

  assert.equal(response.status, 400);

  const body = await response.json();

  assert.equal(body.error.code, 'INVALID_REQUEST');
  assert.match(body.error.message, /tournament roster/);
});