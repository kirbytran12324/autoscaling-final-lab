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

test('validateBattleResult returns valid win and tie results', () => {
  const request = battleRequest();
  const win = battleResult();
  const tie = battleResult({
    outcome: 'tie',
    winnerSide: null,
    winnerSpecies: null,
    turns: 100,
    termination: 'turn-cap',
  });

  assert.strictEqual(
    validateBattleResult(request, win, SIMULATOR_VERSION),
    win
  );
  assert.strictEqual(
    validateBattleResult(request, tie, SIMULATOR_VERSION),
    tie
  );
});

test('validation requires request and result to be non-array objects', () => {
  for (const request of [null, [], 'request']) {
    assert.throws(
      () => validateBattleResult(
        request,
        battleResult(),
        SIMULATOR_VERSION
      ),
      /request must be a non-array object/i
    );
  }

  for (const result of [null, [], 'result']) {
    assert.throws(
      () => validateBattleResult(
        battleRequest(),
        result,
        SIMULATOR_VERSION
      ),
      /result must be a non-array object/i
    );
  }
});

test('validation requires identity fields to exactly match the request', () => {
  for (const [field, value] of [
    ['matchId', 'group-A-000002'],
    ['pokemon1', 'Mew'],
    ['pokemon2', 'Ditto'],
  ]) {
    assert.throws(
      () => validateBattleResult(
        battleRequest(),
        battleResult({[field]: value}),
        SIMULATOR_VERSION
      ),
      new RegExp(field, 'i')
    );
  }

  const request = battleRequest();
  const result = battleResult();
  delete request.matchId;
  delete result.matchId;

  assert.throws(
    () => validateBattleResult(request, result, SIMULATOR_VERSION),
    /matchId/i
  );
});

test('validation requires matching four-integer request and result seeds', () => {
  for (const seed of [null, [1, 2, 3], [1, 2, 3, 4.5]]) {
    assert.throws(
      () => validateBattleResult(
        battleRequest({seed}),
        battleResult(),
        SIMULATOR_VERSION
      ),
      /request seed/i
    );
  }

  for (const seed of [null, [1, 2, 3], [1, 2, 3, 4.5], [1, 2, 3, 4]]) {
    assert.throws(
      () => validateBattleResult(
        battleRequest(),
        battleResult({seed}),
        SIMULATOR_VERSION
      ),
      /seed/i
    );
  }
});

test('validation requires the expected pinned simulator version', () => {
  assert.throws(
    () => validateBattleResult(
      battleRequest(),
      battleResult({simulatorVersion: 'pokemon-showdown@latest'}),
      SIMULATOR_VERSION
    ),
    /simulatorVersion/i
  );

  assert.throws(
    () => validateBattleResult(battleRequest(), battleResult(), undefined),
    /expected simulator version/i
  );
});

test('validation accepts only win or tie outcomes', () => {
  for (const outcome of ['loss', null, undefined]) {
    assert.throws(
      () => validateBattleResult(
        battleRequest(),
        battleResult({outcome}),
        SIMULATOR_VERSION
      ),
      /outcome/i
    );
  }
});

test('a win requires a valid side and its corresponding species', () => {
  for (const winnerSide of ['p3', null, undefined]) {
    assert.throws(
      () => validateBattleResult(
        battleRequest(),
        battleResult({winnerSide}),
        SIMULATOR_VERSION
      ),
      /winnerSide/i
    );
  }

  assert.throws(
    () => validateBattleResult(
      battleRequest(),
      battleResult({winnerSpecies: 'Clefable'}),
      SIMULATOR_VERSION
    ),
    /winnerSpecies/i
  );

  assert.doesNotThrow(() => validateBattleResult(
    battleRequest(),
    battleResult({winnerSide: 'p2', winnerSpecies: 'Clefable'}),
    SIMULATOR_VERSION
  ));
});

test('a tie requires null winner fields', () => {
  for (const overrides of [
    {outcome: 'tie', winnerSide: 'p1', winnerSpecies: null},
    {outcome: 'tie', winnerSide: null, winnerSpecies: 'Snorlax'},
    {outcome: 'tie', winnerSide: undefined, winnerSpecies: null},
  ]) {
    assert.throws(
      () => validateBattleResult(
        battleRequest(),
        battleResult(overrides),
        SIMULATOR_VERSION
      ),
      /tie.*null/i
    );
  }
});

test('turns must be positive integers within the requested maximum', () => {
  for (const turns of [0, -1, 1.5, 101, Infinity]) {
    assert.throws(
      () => validateBattleResult(
        battleRequest(),
        battleResult({turns}),
        SIMULATOR_VERSION
      ),
      /turns/i
    );
  }

  const defaultedRequest = battleRequest();
  delete defaultedRequest.maxTurns;

  assert.doesNotThrow(() => validateBattleResult(
    defaultedRequest,
    battleResult({turns: 100}),
    SIMULATOR_VERSION
  ));
  assert.throws(
    () => validateBattleResult(
      defaultedRequest,
      battleResult({turns: 101}),
      SIMULATOR_VERSION
    ),
    /no greater than 100/i
  );

  assert.doesNotThrow(() => validateBattleResult(
    battleRequest({maxTurns: 5}),
    battleResult({turns: 5}),
    SIMULATOR_VERSION
  ));
  assert.throws(
    () => validateBattleResult(
      battleRequest({maxTurns: 5}),
      battleResult({turns: 6}),
      SIMULATOR_VERSION
    ),
    /no greater than 5/i
  );
});

test('termination must be natural or a consistent turn-cap', () => {
  assert.throws(
    () => validateBattleResult(
      battleRequest(),
      battleResult({termination: 'timeout'}),
      SIMULATOR_VERSION
    ),
    /termination/i
  );

  for (const result of [
    battleResult({termination: 'turn-cap'}),
    battleResult({
      outcome: 'tie',
      winnerSide: null,
      winnerSpecies: null,
      turns: 99,
      termination: 'turn-cap',
    }),
  ]) {
    assert.throws(
      () => validateBattleResult(
        battleRequest(),
        result,
        SIMULATOR_VERSION
      ),
      /turn-cap.*ties.*maxTurns/i
    );
  }
});

test('protocolHash must be exactly 64 lowercase hexadecimal characters', () => {
  for (const protocolHash of [
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    `${'a'.repeat(63)}g`,
    null,
  ]) {
    assert.throws(
      () => validateBattleResult(
        battleRequest(),
        battleResult({protocolHash}),
        SIMULATOR_VERSION
      ),
      /protocolHash/i
    );
  }
});

test('servedBy must be a non-empty string', () => {
  for (const servedBy of ['', '   ', null, 123]) {
    assert.throws(
      () => validateBattleResult(
        battleRequest(),
        battleResult({servedBy}),
        SIMULATOR_VERSION
      ),
      /servedBy/i
    );
  }
});

test('durationMs must be a finite non-negative number', () => {
  for (const durationMs of [-1, NaN, Infinity, '1']) {
    assert.throws(
      () => validateBattleResult(
        battleRequest(),
        battleResult({durationMs}),
        SIMULATOR_VERSION
      ),
      /durationMs/i
    );
  }

  assert.doesNotThrow(() => validateBattleResult(
    battleRequest(),
    battleResult({durationMs: 0}),
    SIMULATOR_VERSION
  ));
});

test('validation returns the result without mutating either input', () => {
  const request = battleRequest();
  const result = battleResult();
  const requestBefore = structuredClone(request);
  const resultBefore = structuredClone(result);

  const validated = validateBattleResult(
    request,
    result,
    SIMULATOR_VERSION
  );

  assert.strictEqual(validated, result);
  assert.deepEqual(request, requestBefore);
  assert.deepEqual(result, resultBefore);
});

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
