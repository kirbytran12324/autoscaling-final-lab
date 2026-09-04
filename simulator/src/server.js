'use strict';

const http = require('node:http');
const os = require('node:os');
const {performance} = require('node:perf_hooks');

const {simulateBattle} = require('./battle');
const {
  getBaseSpecies,
  listBaseSpecies,
  listMetronomeCallableMoves,
} = require('./catalog');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 16 * 1024;

const catalogStatus = {
  speciesCount: listBaseSpecies().length,
  metronomeMoveCount: listMetronomeCallableMoves().length,
};

class RequestError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });

  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;

  for await (const chunk of request) {
    bytes += chunk.length;

    if (bytes > MAX_BODY_BYTES) {
      throw new RequestError(
        413,
        'PAYLOAD_TOO_LARGE',
        'Request body must not exceed 16 KiB'
      );
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    throw new RequestError(
      400,
      'INVALID_REQUEST',
      'Request body is required'
    );
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(
      400,
      'INVALID_JSON',
      'Request body must contain valid JSON'
    );
  }
}

function validateBattleRequest(body) {
  if (
    body === null ||
    typeof body !== 'object' ||
    Array.isArray(body)
  ) {
    throw new RequestError(
      400,
      'INVALID_REQUEST',
      'Request body must be a JSON object'
    );
  }

  if (
    typeof body.matchId !== 'string' ||
    body.matchId.trim() === ''
  ) {
    throw new RequestError(
      400,
      'INVALID_REQUEST',
      'matchId must be a non-empty string'
    );
  }

  if (
    !Array.isArray(body.seed) ||
    body.seed.length !== 4 ||
    body.seed.some(value =>
      !Number.isInteger(value) ||
      value < 0 ||
      value > 65535
    )
  ) {
    throw new RequestError(
      400,
      'INVALID_REQUEST',
      'seed must contain four integers from 0 through 65535'
    );
  }

  const pokemon1 = getBaseSpecies(body.pokemon1);
  const pokemon2 = getBaseSpecies(body.pokemon2);
  const maxTurns = body.maxTurns ?? 100;

  if (
    !Number.isInteger(maxTurns) ||
    maxTurns < 1 ||
    maxTurns > 10_000
  ) {
    throw new RequestError(
      400,
      'INVALID_REQUEST',
      'maxTurns must be an integer from 1 through 10000'
    );
  }

  return {
    matchId: body.matchId.trim(),
    pokemon1: pokemon1.name,
    pokemon2: pokemon2.name,
    seed: [...body.seed],
    maxTurns,
  };
}

async function handleBattle(request, response) {
  const contentType = request.headers['content-type'] || '';

  if (!contentType.startsWith('application/json')) {
    throw new RequestError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Content-Type must be application/json'
    );
  }

  const body = await readJson(request);
  const input = validateBattleRequest(body);
  const started = performance.now();

  const result = await simulateBattle(input);

  sendJson(response, 200, {
    matchId: input.matchId,
    pokemon1: input.pokemon1,
    pokemon2: input.pokemon2,
    outcome: result.outcome,
    winnerSide: result.winnerSide,
    winnerSpecies:
      result.winnerSide === 'p1'
        ? input.pokemon1
        : result.winnerSide === 'p2'
          ? input.pokemon2
          : null,
    turns: result.turns,
    termination: result.termination,
    protocolHash: result.protocolHash,
    servedBy: process.env.HOSTNAME || os.hostname(),
    durationMs: Number(
      (performance.now() - started).toFixed(3)
    ),
  });
}

function createServer() {
  return http.createServer(async (request, response) => {
    try {
      if (
        request.method === 'GET' &&
        request.url === '/health/live'
      ) {
        sendJson(response, 200, {status: 'ok'});
        return;
      }

      if (
        request.method === 'GET' &&
        request.url === '/health/ready'
      ) {
        const ready =
          catalogStatus.speciesCount === 1025 &&
          catalogStatus.metronomeMoveCount === 581;

        sendJson(response, ready ? 200 : 503, {
          status: ready ? 'ready' : 'not-ready',
          ...catalogStatus,
        });
        return;
      }

      if (
        request.method === 'POST' &&
        request.url === '/v1/battles'
      ) {
        await handleBattle(request, response);
        return;
      }

      sendJson(response, 404, {
        error: {
          code: 'NOT_FOUND',
          message: 'Route not found',
        },
      });
    } catch (error) {
      if (error instanceof RequestError) {
        sendJson(response, error.statusCode, {
          error: {
            code: error.code,
            message: error.message,
          },
        });
        return;
      }

      if (
        error instanceof TypeError ||
        error instanceof RangeError
      ) {
        sendJson(response, 400, {
          error: {
            code: 'INVALID_REQUEST',
            message: error.message,
          },
        });
        return;
      }

      console.error(error);

      sendJson(response, 500, {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Battle simulation failed',
        },
      });
    }
  });
}

if (require.main === module) {
  const server = createServer();

  server.listen(PORT, HOST, () => {
    console.log(
      `Simulator listening on http://${HOST}:${PORT}`
    );
  });
}

module.exports = {createServer};