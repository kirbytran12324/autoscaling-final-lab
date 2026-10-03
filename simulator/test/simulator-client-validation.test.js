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
