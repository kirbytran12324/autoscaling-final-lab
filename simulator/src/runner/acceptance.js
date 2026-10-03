"use strict";

const {performance} = require('node:perf_hooks');

// Every stage uses this one serialized durability lane. HTTP concurrency stays
// bounded by its executor; checkpoint policy remains a stage responsibility.
function createAcceptanceQueue({accept, onError, observe = () => {}}) {
  let tail = Promise.resolve();
  return {
    enqueue(match, response, context) {
      const queuedAt = performance.now();
      const operation = tail.then(() => {
        observe({operation: 'acceptance-wait', matchId: match.matchId,
          durationMs: performance.now() - queuedAt});
        return accept(match, response, context);
      });
      tail = operation.catch(error => onError(match, error));
      return operation;
    },
    drain() { return tail; },
  };
}

module.exports = {createAcceptanceQueue};
