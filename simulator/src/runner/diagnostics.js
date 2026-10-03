"use strict";

const {performance} = require('node:perf_hooks');
const {basename} = require('node:path');

function createDiagnostics(options) {
  const sink = options.onDiagnostic;
  if (sink !== undefined && typeof sink !== 'function') {
    throw new TypeError('onDiagnostic must be a function');
  }
  function observe(event) {
    if (!sink) return;
    // Diagnostic failures cannot change acceptance or persistence semantics.
    try { Promise.resolve(sink({...event, heapUsedBytes: process.memoryUsage().heapUsed}))
      .catch(() => {}); } catch { /* best-effort diagnostics */ }
  }
  function timed(operation, invoke) {
    if (!sink) return invoke;
    return async (...args) => {
      const started = performance.now();
      let succeeded = false;
      try { const result = await invoke(...args); succeeded = true; return result; }
      finally {
        observe({operation: typeof operation === 'function' ? operation(...args) : operation,
          durationMs: performance.now() - started, succeeded});
      }
    };
  }
  return {
    observe,
    derive: invoke => {
      if (!sink) return invoke;
      return (...args) => {
        const started = performance.now();
        let succeeded = false;
        try { const result = invoke(...args); succeeded = true; return result; }
        finally { observe({operation: 'derived-artifact-compute',
          durationMs: performance.now() - started, succeeded}); }
      };
    },
    request: invoke => timed('request', invoke),
    append: invoke => timed('append-flush', invoke),
    write: invoke => timed(file => basename(file) === 'checkpoint.json'
      ? 'checkpoint' : 'derived-artifact', invoke),
  };
}

module.exports = {createDiagnostics};
