'use strict';

const {ArtifactStoreError} = require('../errors');
function normalizedCursorState(state) {
  return Object.fromEntries(Object.entries(state).sort(([left], [right]) =>
    left.localeCompare(right)
  ));
}

function encodeCursor(offset, state) {
  return Buffer.from(JSON.stringify({offset, state: normalizedCursorState(state)}), 'utf8')
    .toString('base64url');
}

function decodeCursor(cursor, state, description = 'Match') {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(parsed.offset) || parsed.offset < 0 ||
        JSON.stringify(parsed.state) !== JSON.stringify(normalizedCursorState(state))) {
      throw new Error('invalid cursor');
    }
    return parsed.offset;
  } catch {
    throw new ArtifactStoreError(400, 'INVALID_CURSOR', `${description} cursor is invalid.`);
  }
}
module.exports = {encodeCursor, decodeCursor};
