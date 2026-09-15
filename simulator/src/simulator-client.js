'use strict';

const RETRY_DELAYS_MS = Object.freeze([250, 500, 1000]);
const DEFAULT_TIMEOUT_MS = 30_000;

function isNonArrayObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidResult(message) {
  throw new TypeError(`Invalid battle result: ${message}`);
}

function validateBattleResult(request, result, expectedSimulatorVersion) {
  if (!isNonArrayObject(request)) {
    invalidResult('request must be a non-array object');
  }

  if (!isNonArrayObject(result)) {
    invalidResult('result must be a non-array object');
  }

  for (const field of ['matchId', 'pokemon1', 'pokemon2']) {
    if (!Object.hasOwn(request, field) ||
        !Object.hasOwn(result, field) ||
        result[field] !== request[field]) {
      invalidResult(`${field} must exactly match the request`);
    }
  }

  if (!Array.isArray(request.seed) ||
      request.seed.length !== 4 ||
      request.seed.some(value => !Number.isInteger(value))) {
    invalidResult('request seed must be an array of four integers');
  }

  if (!Array.isArray(result.seed) ||
      result.seed.length !== 4 ||
      result.seed.some(value => !Number.isInteger(value)) ||
      result.seed.some((value, index) => value !== request.seed[index])) {
    invalidResult('seed must be four integers exactly matching the request');
  }

  if (typeof expectedSimulatorVersion !== 'string' ||
      expectedSimulatorVersion.trim() === '') {
    invalidResult('expected simulator version must be a non-empty string');
  }

  if (result.simulatorVersion !== expectedSimulatorVersion) {
    invalidResult('simulatorVersion must match the expected pinned version');
  }

  if (result.outcome !== 'win' && result.outcome !== 'tie') {
    invalidResult('outcome must be win or tie');
  }

  if (result.outcome === 'win') {
    if (result.winnerSide !== 'p1' && result.winnerSide !== 'p2') {
      invalidResult('a win must have winnerSide p1 or p2');
    }

    const expectedWinner = result.winnerSide === 'p1'
      ? request.pokemon1
      : request.pokemon2;

    if (result.winnerSpecies !== expectedWinner) {
      invalidResult(
        'winnerSpecies must match the participant identified by winnerSide'
      );
    }
  } else if (result.winnerSide !== null || result.winnerSpecies !== null) {
    invalidResult('a tie must have null winnerSide and winnerSpecies');
  }

  const maxTurns = request.maxTurns === undefined ? 100 : request.maxTurns;

  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    invalidResult('request maxTurns must be a positive integer');
  }

  if (!Number.isInteger(result.turns) ||
      result.turns < 1 ||
      result.turns > maxTurns) {
    invalidResult(`turns must be a positive integer no greater than ${maxTurns}`);
  }

  if (result.termination !== 'natural' &&
      result.termination !== 'turn-cap') {
    invalidResult('termination must be natural or turn-cap');
  }

  if (result.termination === 'turn-cap' &&
      (result.outcome !== 'tie' || result.turns !== maxTurns)) {
    invalidResult('turn-cap results must be ties at exactly maxTurns');
  }

  if (typeof result.protocolHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(result.protocolHash)) {
    invalidResult(
      'protocolHash must contain exactly 64 lowercase hexadecimal characters'
    );
  }

  if (typeof result.servedBy !== 'string' || result.servedBy.trim() === '') {
    invalidResult('servedBy must be a non-empty string');
  }

  if (typeof result.durationMs !== 'number' ||
      !Number.isFinite(result.durationMs) ||
      result.durationMs < 0) {
    invalidResult('durationMs must be a finite non-negative number');
  }

  return result;
}

function defaultSleep(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

function validateClientOptions(options) {
  if (!isNonArrayObject(options)) {
    throw new TypeError('Simulator client options must be a non-array object');
  }

  if (typeof options.baseUrl !== 'string' || options.baseUrl.trim() === '') {
    throw new TypeError('baseUrl must be a non-empty string');
  }

  if (typeof options.expectedSimulatorVersion !== 'string' ||
      options.expectedSimulatorVersion.trim() === '') {
    throw new TypeError('expectedSimulatorVersion must be a non-empty string');
  }

  const timeoutMs = options.timeoutMs === undefined
    ? DEFAULT_TIMEOUT_MS
    : options.timeoutMs;

  if (typeof timeoutMs !== 'number' ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 0) {
    throw new TypeError('timeoutMs must be a finite non-negative number');
  }

  const fetchImpl = options.fetchImpl === undefined
    ? globalThis.fetch
    : options.fetchImpl;
  const sleepImpl = options.sleepImpl === undefined
    ? defaultSleep
    : options.sleepImpl;

  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function');
  }

  if (typeof sleepImpl !== 'function') {
    throw new TypeError('sleepImpl must be a function');
  }

  return {
    url: `${options.baseUrl.trim().replace(/\/+$/, '')}/v1/battles`,
    expectedSimulatorVersion: options.expectedSimulatorVersion,
    timeoutMs,
    fetchImpl,
    sleepImpl,
  };
}

function createSimulatorClient(options) {
  const {
    url,
    expectedSimulatorVersion,
    timeoutMs,
    fetchImpl,
    sleepImpl,
  } = validateClientOptions(options);

  return {
    async runBattle(request) {
      const requestBody = JSON.stringify(request);
      let finalFailure;

      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) {
          await sleepImpl(RETRY_DELAYS_MS[attempt - 1]);
        }

        const controller = new AbortController();
        const timeoutError = new Error(
          `Battle request timed out after ${timeoutMs} ms`
        );
        timeoutError.name = 'TimeoutError';
        timeoutError.code = 'SIMULATOR_TIMEOUT';

        let timeoutHandle;
        const timeout = new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            controller.abort(timeoutError);
            reject(timeoutError);
          }, timeoutMs);
        });

        try {
          const operation = Promise.resolve().then(async () => {
            const response = await fetchImpl(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Connection': 'close',
              },
              body: requestBody,
              signal: controller.signal,
            });

            if (!response ||
                !Number.isInteger(response.status) ||
                response.status < 200 ||
                response.status >= 300) {
              const responseError = new Error(
                `Simulator returned HTTP ${response && response.status}`
              );
              responseError.code = 'SIMULATOR_HTTP_ERROR';
              responseError.status = Number.isInteger(response && response.status)
                ? response.status
                : null;
              throw responseError;
            }

            const result = await response.json();
            return validateBattleResult(
              request,
              result,
              expectedSimulatorVersion
            );
          });

          return await Promise.race([operation, timeout]);
        } catch (error) {
          finalFailure = error;
        } finally {
          clearTimeout(timeoutHandle);
        }
      }

      const exhaustedError = new Error(
        `Battle ${String(request && request.matchId)} failed after 4 attempts`,
        {cause: finalFailure}
      );
      exhaustedError.code = 'SIMULATOR_RETRIES_EXHAUSTED';
      exhaustedError.attempts = 4;
      throw exhaustedError;
    },
  };
}

module.exports = {
  createSimulatorClient,
  validateBattleResult,
};
