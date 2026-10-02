'use strict';

const {ArtifactStoreError} = require('../errors');
const {encodeCursor, decodeCursor} = require('./cursors');
async function getStandings(runId, {
    group = '', cursor, limit = 25, query = '',
  } = {}) {
    const standings = (await this.loadCompletedRun(runId)).standings;
    const selected = group === ''
      ? standings.groups[0]
      : standings.groups.find(item => item.group === group);
    if (!selected) {
      throw new ArtifactStoreError(400, 'INVALID_GROUP', 'Standing group is invalid.');
    }
    const normalizedQuery = query.trim().toLocaleLowerCase('en-US');
    const entries = selected.standings.filter(entry => normalizedQuery === '' ||
      entry.species.toLocaleLowerCase('en-US').includes(normalizedQuery));
    const state = {resource: 'standings', group: selected.group, query: normalizedQuery};
    const offset = decodeCursor(cursor, state, 'Standing');
    if (offset > entries.length) {
      throw new ArtifactStoreError(400, 'INVALID_CURSOR', 'Standing cursor is invalid.');
    }
    const items = entries.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    return {
      advancingCount: standings.advancingCount,
      updatedAt: standings.updatedAt,
      groups: standings.groups.map(item => ({
        group: item.group,
        completedMatches: item.completedMatches,
        expectedMatches: item.expectedMatches,
        entrantCount: item.standings.length,
      })),
      selectedGroup: selected.group,
      items,
      total: entries.length,
      nextCursor: nextOffset < entries.length ? encodeCursor(nextOffset, state) : null,
    };
  }
module.exports = {getStandings};
