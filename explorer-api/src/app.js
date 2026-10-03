'use strict';

const {ApiError} = require('./errors');
const {MATCH_SORTS, SORT_DIRECTIONS} = require('./artifact-store');

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function sendJson(response, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
}

function decodeSegment(value, description) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(400, 'INVALID_PATH', `${description} is invalid.`);
  }
}

function parseLimit(rawLimit) {
  if (rawLimit === null) return DEFAULT_PAGE_SIZE;
  if (!/^\d+$/.test(rawLimit)) {
    throw new ApiError(400, 'INVALID_LIMIT', 'limit must be a positive integer.');
  }
  const limit = Number(rawLimit);
  if (limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new ApiError(
      400,
      'INVALID_LIMIT',
      `limit must be between 1 and ${MAX_PAGE_SIZE}.`
    );
  }
  return limit;
}

function parseBoundedString(parameters, name, maximum, {trim = true} = {}) {
  const raw = parameters.get(name) || '';
  if (raw.length > maximum) {
    throw new ApiError(400, 'INVALID_QUERY', `${name} is too long.`);
  }
  return trim ? raw.trim() : raw;
}

function parseEnum(parameters, name, allowed) {
  const value = parameters.get(name) || '';
  if (value !== '' && !allowed.includes(value)) {
    throw new ApiError(400, 'INVALID_QUERY', `${name} is invalid.`);
  }
  return value;
}

function assertAllowedParameters(parameters, allowed) {
  for (const name of parameters.keys()) {
    if (!allowed.includes(name)) {
      throw new ApiError(400, 'INVALID_QUERY', `Unknown query parameter: ${name}.`);
    }
  }
}

function publicError(error) {
  if (error instanceof ApiError) return error;
  return new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
}

function createApp({store, logger = console, readiness = async () => true, replays}) {
  if (!store) throw new TypeError('store is required');

  return async function app(request, response) {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health/live' || url.pathname === '/health/ready') {
        if (request.method !== 'GET') {
          throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.');
        }
        if (url.pathname === '/health/ready') {
          let ready = false;
          try { ready = await readiness(); } catch { /* storage outage */ }
          return sendJson(response, ready ? 200 : 503, {status: ready ? 'ok' : 'not-ready'});
        }
        return sendJson(response, 200, {status: 'ok'});
      }
      if (!url.pathname.startsWith('/api/')) {
        throw new ApiError(404, 'NOT_FOUND', 'Endpoint was not found.');
      }
      if (request.method !== 'GET') {
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'The explorer API is read-only.');
      }

      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'runs') {
        return sendJson(response, 200, {runs: await store.listRuns()});
      }
      if (parts.length < 3 || parts[0] !== 'api' || parts[1] !== 'runs') {
        throw new ApiError(404, 'NOT_FOUND', 'Endpoint was not found.');
      }

      const runId = decodeSegment(parts[2], 'Run ID');
      if (parts.length === 3) {
        return sendJson(response, 200, {run: await store.getRun(runId)});
      }
      if (parts.length === 4 && parts[3] === 'standings') {
        assertAllowedParameters(url.searchParams, ['group', 'q', 'cursor', 'limit']);
        const query = parseBoundedString(url.searchParams, 'q', 100);
        const group = parseBoundedString(url.searchParams, 'group', 16);
        return sendJson(response, 200, {standings: await store.getStandings(runId, {
          group,
          query,
          cursor: url.searchParams.get('cursor'),
          limit: parseLimit(url.searchParams.get('limit')),
        })});
      }
      if (parts.length === 4 && parts[3] === 'bracket') {
        return sendJson(response, 200, {bracket: await store.getBracket(runId)});
      }
      if (parts.length === 4 && parts[3] === 'matches') {
        assertAllowedParameters(url.searchParams, [
          'q', 'stage', 'result', 'hostname', 'sort', 'direction', 'cursor', 'limit',
        ]);
        const query = parseBoundedString(url.searchParams, 'q', 100);
        const stage = parseEnum(url.searchParams, 'stage', ['Group stage', 'Knockout']);
        const result = parseEnum(url.searchParams, 'result', ['win', 'tie']);
        const hostname = parseBoundedString(url.searchParams, 'hostname', 200);
        const sort = parseEnum(url.searchParams, 'sort', MATCH_SORTS) || 'matchId';
        const direction = parseEnum(url.searchParams, 'direction', SORT_DIRECTIONS) || 'asc';
        const page = await store.listMatches(runId, {
          cursor: url.searchParams.get('cursor'),
          limit: parseLimit(url.searchParams.get('limit')),
          query,
          stage,
          result,
          hostname,
          sort,
          direction,
        });
        return sendJson(response, 200, page);
      }
      if (parts.length === 5 && parts[3] === 'matches') {
        const matchId = decodeSegment(parts[4], 'Match ID');
        return sendJson(response, 200, {match: await store.getMatch(runId, matchId)});
      }
      if (parts.length === 6 && parts[3] === 'matches' && parts[5] === 'replay') {
        assertAllowedParameters(url.searchParams, []);
        if (!replays) throw new ApiError(503, 'REPLAY_UNAVAILABLE', 'Replay generation is unavailable.');
        return sendJson(response, 200, await replays.getReplay(runId, decodeSegment(parts[4], 'Match ID')));
      }
      if (parts.length === 4 && parts[3] === 'report') {
        const report = await store.getReport(runId);
        response.writeHead(200, {
          'content-type': report.contentType,
          'content-length': report.size,
          'content-disposition': `attachment; filename="${report.fileName}"`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        return response.end(report.body);
      }
      throw new ApiError(404, 'NOT_FOUND', 'Endpoint was not found.');
    } catch (error) {
      const safe = publicError(error);
      if (safe.status >= 500) {
        logger.error('Explorer API request failed', {code: safe.code, cause: error.cause || error});
      }
      if (!response.headersSent) {
        sendJson(response, safe.status, {error: {code: safe.code, message: safe.message}});
      } else {
        response.destroy();
      }
    }
  };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  assertAllowedParameters,
  createApp,
  parseLimit,
};
