"use strict";

const {ArtifactStoreError} = require('../errors');
const {validateMatchId, collator} = require('./contracts');
const {decodeCursor, encodeCursor} = require('./cursors');
const {enrichMatch} = require('./context');
const QUERY_CACHE_SIZE = 8;

function matchIndex(artifacts) {
  if (!artifacts.matchIndex) {
    const byId = new Map();
    for (const match of artifacts.results) byId.set(match.matchId, match);
    artifacts.matchIndex = {byId, sorts: new Map(), queries: new Map()};
  }
  return artifacts.matchIndex;
}

function sortValue(artifacts, match, sort) {
  if (sort === 'stage') return artifacts.matchContext.get(match.matchId)?.stage || 'Unknown';
  if (sort === 'matchup') return `${match.pokemon1}\u0000${match.pokemon2}`;
  if (sort === 'result') return match.outcome;
  if (sort === 'winner') return match.winnerSpecies || '';
  return match[sort];
}

function orderedIndexes(artifacts, sort, direction) {
  const index = matchIndex(artifacts);
  const key = `${sort}:${direction}`;
  if (!index.sorts.has(key)) {
    const positions = Uint32Array.from({length: artifacts.results.length}, (_, position) => position);
    positions.sort((a, b) => {
      const left = artifacts.results[a];
      const right = artifacts.results[b];
      const lv = sortValue(artifacts, left, sort);
      const rv = sortValue(artifacts, right, sort);
      const compared = typeof lv === 'number' && typeof rv === 'number'
        ? lv - rv : collator.compare(String(lv ?? ''), String(rv ?? ''));
      // Descending reverses only the primary key, never the match-ID tie-break.
      return (direction === 'desc' ? -compared : compared) || left.matchId.localeCompare(right.matchId);
    });
    index.sorts.set(key, positions);
  }
  return index.sorts.get(key);
}

function filteredIndexes(artifacts, state) {
  const ordered = orderedIndexes(artifacts, state.sort, state.direction);
  if (!state.query && !state.stage && !state.result && !state.hostname) return ordered;
  const cache = matchIndex(artifacts).queries;
  const key = JSON.stringify(state);
  if (cache.has(key)) {
    const positions = cache.get(key); cache.delete(key); cache.set(key, positions);
    return positions;
  }
  const positions = ordered.filter(position => {
    const match = artifacts.results[position];
    return (!state.query || [match.matchId, match.pokemon1, match.pokemon2]
      .some(value => String(value || '').toLocaleLowerCase('en-US').includes(state.query))) &&
      (!state.stage || sortValue(artifacts, match, 'stage') === state.stage) &&
      (!state.result || match.outcome === state.result) &&
      (!state.hostname || match.servedBy === state.hostname);
  });
  cache.set(key, positions);
  if (cache.size > QUERY_CACHE_SIZE) cache.delete(cache.keys().next().value);
  return positions;
}

async function listMatches(runId, {
  cursor, limit, query = '', stage = '', result = '', hostname = '',
  sort = 'matchId', direction = 'asc',
}) {
  const artifacts = await this.loadCompletedRun(runId);
  const state = {resource: 'matches', query: query.trim().toLocaleLowerCase('en-US'),
    stage, result, hostname, sort, direction};
  const offset = decodeCursor(cursor, state, 'Match');
  const positions = filteredIndexes(artifacts, state);
  if (offset > positions.length) throw new ArtifactStoreError(400, 'INVALID_CURSOR', 'Match cursor is invalid.');
  const end = Math.min(offset + limit, positions.length);
  const items = [];
  for (let position = offset; position < end; position++) {
    items.push(enrichMatch(artifacts.results[positions[position]], artifacts.matchContext));
  }
  return {items, total: positions.length,
    nextCursor: end < positions.length ? encodeCursor(end, state) : null};
}

async function getMatch(runId, matchId) {
  validateMatchId(matchId);
  const artifacts = await this.loadCompletedRun(runId);
  const match = matchIndex(artifacts).byId.get(matchId);
  if (!match) throw new ArtifactStoreError(404, 'MATCH_NOT_FOUND', 'Tournament match was not found.');
  return enrichMatch(match, artifacts.matchContext);
}

module.exports = {listMatches, getMatch};
