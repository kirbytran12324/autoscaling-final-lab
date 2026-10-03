'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createSimulatorClient,
  validateBattleResult,
} = require('../src/simulator-client');
const {
  SIMULATOR_VERSION,
  battleRequest,
  battleResult,
  jsonResponse,
  clientOptions
} = require('../test-support/simulator-client');

test('runBattle posts the unchanged JSON request and validates the response', async () => {
  const request = battleRequest();
  const result = battleResult();
  const calls = [];
  const client = createSimulatorClient(clientOptions({
    baseUrl: 'http://simulator.default.svc:3000/',
    fetchImpl: async (...args) => {
      calls.push(args);
      return jsonResponse(result);
    },
  }));

  const returned = await client.runBattle(request);

  assert.strictEqual(returned, result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'http://simulator.default.svc:3000/v1/battles');
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(calls[0][1].headers, {
    'Content-Type': 'application/json',
    'Connection': 'close',
  });
  assert.deepEqual(JSON.parse(calls[0][1].body), request);
  assert.ok(calls[0][1].signal instanceof AbortSignal);
});

test('runBattle retries with unchanged data and routing headers', async () => {
  const request = battleRequest();
  const requestBefore = structuredClone(request);
  const bodies = [];
  const headers = [];
  const signals = [];
  const delays = [];
  let attempt = 0;
  const client = createSimulatorClient(clientOptions({
    fetchImpl: async (url, options) => {
      bodies.push(options.body);
      headers.push(options.headers);
      signals.push(options.signal);
      attempt++;

      if (attempt < 4) {
        throw new Error(`temporary failure ${attempt}`);
      }

      return jsonResponse(battleResult());
    },
    sleepImpl: async delay => delays.push(delay),
  }));

  await client.runBattle(request);

  assert.deepEqual(delays, [250, 500, 1000]);
  assert.equal(bodies.length, 4);
  assert.ok(bodies.every(body => body === bodies[0]));
  assert.deepEqual(JSON.parse(bodies[0]), requestBefore);
  assert.deepEqual(headers, Array.from({length: 4}, () => ({
    'Content-Type': 'application/json',
    'Connection': 'close',
  })));
  assert.deepEqual(request, requestBefore);
  assert.equal(new Set(signals).size, 4);
  assert.ok(signals.every(signal => !signal.aborted));
});

test('runBattle recovers after each non-timeout failure type', async t => {
  const finalResult = battleResult();
  const failureCases = [
    {
      name: 'non-2xx response',
      fail: async () => ({ok: false, status: 503}),
    },
    {
      name: 'malformed JSON',
      fail: async () => ({
        ok: true,
        status: 200,
        async json() {
          throw new SyntaxError('Unexpected token');
        },
      }),
    },
    {
      name: 'invalid response',
      fail: async () => jsonResponse(battleResult({winnerSide: 'p3'})),
    },
    {
      name: 'fetch failure',
      fail: async () => {
        throw new Error('connection reset');
      },
    },
  ];

  for (const failureCase of failureCases) {
    await t.test(failureCase.name, async () => {
      let attempts = 0;
      const delays = [];
      const client = createSimulatorClient(clientOptions({
        fetchImpl: async (...args) => {
          attempts++;
          return attempts === 1
            ? failureCase.fail(...args)
            : jsonResponse(finalResult);
        },
        sleepImpl: async delay => delays.push(delay),
      }));

      assert.strictEqual(await client.runBattle(battleRequest()), finalResult);
      assert.equal(attempts, 2);
      assert.deepEqual(delays, [250]);
    });
  }
});

test('runBattle aborts a timed-out attempt and then recovers', async () => {
  const signals = [];
  const delays = [];
  let attempts = 0;
  const client = createSimulatorClient(clientOptions({
    timeoutMs: 0,
    fetchImpl: async (url, {signal}) => {
      attempts++;
      signals.push(signal);

      if (attempts === 1) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      }

      return jsonResponse(battleResult());
    },
    sleepImpl: async delay => delays.push(delay),
  }));

  const result = await client.runBattle(battleRequest());

  assert.equal(result.matchId, 'group-A-000001');
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [250]);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[0].reason.name, 'TimeoutError');
  assert.notStrictEqual(signals[0], signals[1]);
});

test('runBattle exhausts four attempts with an informative preserved cause', async () => {
  const failures = [1, 2, 3, 4].map(
    attempt => new Error(`failure ${attempt}`)
  );
  const delays = [];
  let attempts = 0;
  const client = createSimulatorClient(clientOptions({
    fetchImpl: async () => {
      throw failures[attempts++];
    },
    sleepImpl: async delay => delays.push(delay),
  }));

  const error = await client.runBattle(battleRequest()).catch(value => value);

  assert.equal(attempts, 4);
  assert.deepEqual(delays, [250, 500, 1000]);
  assert.match(error.message, /group-A-000001/);
  assert.match(error.message, /4 attempts/);
  assert.strictEqual(error.cause, failures[3]);
});

test('runBattle does not mutate frozen request or response data', async () => {
  const request = battleRequest();
  Object.freeze(request.seed);
  Object.freeze(request);
  const result = battleResult();
  Object.freeze(result.seed);
  Object.freeze(result);
  const client = createSimulatorClient(clientOptions({
    fetchImpl: async () => jsonResponse(result),
  }));

  assert.strictEqual(await client.runBattle(request), result);
});
