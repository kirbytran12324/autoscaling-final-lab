'use strict';

const {createHash} = require('node:crypto');
const {ApiError} = require('./errors');
const {DETERMINISTIC_RESULT_FIELDS, haveSameDeterministicResult} =
  require('../../simulator/src/deterministic-result');

const MAX_LOG_BYTES = 1024 * 1024;
const RULES_VERSION = 'metronome-singles-v1';
const SIMULATOR_VERSION = 'pokemon-showdown@0.11.11';

function createReplayClient({baseUrl = 'http://127.0.0.1:3000', timeoutMs = 30000,
  fetchImpl = fetch} = {}) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash) throw new TypeError('SIMULATOR_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment');
  const endpoint = `${url.toString().replace(/\/$/, '')}/v1/battles/replay`;
  return async input => {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {method: 'POST', signal,
        headers: {'content-type': 'application/json', accept: 'application/json'},
        body: JSON.stringify(input)});
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiError(response.status === 422 ? 422 : 503,
          response.status === 422 ? 'REPLAY_UNSUPPORTED' : 'REPLAY_UNAVAILABLE',
          response.status === 422 ? 'This rule or simulator version is not supported for replay.' :
            'The replay simulator is temporarily unavailable. Try again.');
      }
      const chunks = [];
      let bytes = 0;
      if (!response.body) throw new Error('Missing replay response body');
      const reader = response.body.getReader();
      try {
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 2 * MAX_LOG_BYTES) {
            await reader.cancel();
            throw new ApiError(502, 'REPLAY_TOO_LARGE', 'The replay exceeded its size limit.');
          }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (signal.aborted) throw new ApiError(504, 'REPLAY_TIMEOUT', 'Replay generation timed out. Try again.', {cause: error});
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'REPLAY_UNAVAILABLE', 'The replay simulator is temporarily unavailable. Try again.', {cause: error});
    }
  };
}

class ReplayService {
  constructor({store, generate = createReplayClient(), logger = console, now = Date.now,
    ttlMs = 300000, maxEntries = 100, maxBytes = 16 * 1024 * 1024, concurrency = 2} = {}) {
    Object.assign(this, {store, generate, logger, now, ttlMs, maxEntries, maxBytes, concurrency});
    this.cache = new Map();
    this.pending = new Map();
    this.cacheBytes = 0;
  }

  remove(key) {
    const entry = this.cache.get(key);
    if (entry) this.cacheBytes -= entry.bytes;
    this.cache.delete(key);
  }

  async getReplay(runId, matchId) {
    const context = await this.store.getReplayContext(runId, matchId);
    const expected = structuredClone(context.match);
    if (context.rulesVersion !== RULES_VERSION || context.simulatorVersion !== SIMULATOR_VERSION ||
        expected.simulatorVersion !== SIMULATOR_VERSION) {
      throw new ApiError(422, 'REPLAY_UNSUPPORTED', 'This rule or simulator version is not supported for replay.');
    }
    const identity = [runId, matchId, context.rulesVersion, context.simulatorVersion,
      ...DETERMINISTIC_RESULT_FIELDS.map(field => expected[field])];
    const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      this.logger.info('Replay cache hit', {runId, matchId});
      return cached.payload;
    }
    this.remove(key);
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.pending.size >= this.concurrency) {
      throw new ApiError(503, 'REPLAY_BUSY', 'The replay simulator is busy. Try again shortly.');
    }
    const promise = this.regenerate(runId, matchId, context, expected, key)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  async regenerate(runId, matchId, context, expected, key) {
    const started = this.now();
    try {
      const response = await this.generate({matchId, pokemon1: expected.pokemon1,
        pokemon2: expected.pokemon2, seed: expected.seed, maxTurns: 100,
        rulesVersion: context.rulesVersion, simulatorVersion: context.simulatorVersion});
      if (!response || typeof response.result !== 'object' || !response.result ||
          typeof response.log !== 'string' || !response.log.trim()) {
        throw new ApiError(502, 'REPLAY_INVALID_RESPONSE', 'The simulator returned an invalid replay.');
      }
      if (Buffer.byteLength(response.log, 'utf8') > MAX_LOG_BYTES) {
        throw new ApiError(502, 'REPLAY_TOO_LARGE', 'The replay exceeded its size limit.');
      }
      if (/^\|(split|request|t:)\|/m.test(response.log)) {
        throw new ApiError(502, 'REPLAY_INVALID_RESPONSE', 'The simulator returned an invalid spectator log.');
      }
      if (!haveSameDeterministicResult(expected, response.result)) {
        const fields = DETERMINISTIC_RESULT_FIELDS.filter(field =>
          !haveSameDeterministicResult({...expected, [field]: response.result[field]}, expected));
        this.logger.error('Replay verification failed', {runId, matchId, fields});
        throw new ApiError(409, 'REPLAY_MISMATCH', 'The regenerated battle does not match the saved result. Playback was blocked.');
      }
      const payload = {replay: {runId, matchId, rulesVersion: context.rulesVersion,
        simulatorVersion: context.simulatorVersion, protocolHash: expected.protocolHash,
        verified: true, log: response.log}};
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      if (this.maxEntries > 0 && bytes <= this.maxBytes) {
        while (this.cache.size && (this.cache.size >= this.maxEntries || this.cacheBytes + bytes > this.maxBytes)) {
          this.remove(this.cache.keys().next().value);
        }
        this.cache.set(key, {payload, bytes, expires: this.now() + this.ttlMs});
        this.cacheBytes += bytes;
      }
      this.logger.info('Replay regenerated', {runId, matchId, durationMs: this.now() - started, bytes});
      return payload;
    } catch (error) {
      if (error.code !== 'REPLAY_MISMATCH') this.logger.error('Replay generation failed',
        {runId, matchId, code: error.code || 'REPLAY_UNAVAILABLE', durationMs: this.now() - started});
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'REPLAY_UNAVAILABLE', 'Replay generation failed. Try again.', {cause: error});
    }
  }
}

module.exports = {ReplayService, createReplayClient, MAX_LOG_BYTES};
