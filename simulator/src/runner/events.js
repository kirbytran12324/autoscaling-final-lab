'use strict';

// Observability must never change result acceptance or recovery semantics.
function emitRunnerEvent(options, event) {
  try { Promise.resolve(options.onEvent?.(event)).catch(() => {}); }
  catch { /* best-effort observer */ }
}

module.exports = {emitRunnerEvent};
