'use strict';



function integrityVerified(data) {
  return data.rosterHashVerified && data.duplicateMatchIdCount === 0 &&
    data.uniqueResultCount === data.results.length && data.metadata.status === 'completed' &&
    data.checkpoint.stage === 'complete' && data.standings.status === 'final' &&
    data.bracket.status === 'completed';
}

module.exports = {integrityVerified};
