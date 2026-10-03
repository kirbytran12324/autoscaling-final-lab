"use strict";
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createAcceptanceQueue} = require('../src/runner/acceptance');
const {createDiagnostics} = require('../src/runner/diagnostics');

test('shared acceptance serializes work and preserves stage context and errors', async () => {
  const events = []; const failures = []; const observations = [];
  const queue = createAcceptanceQueue({
    async accept(request, response, context) {
      events.push(`start-${request.matchId}`);
      await new Promise(resolve => setImmediate(resolve));
      if (response.fail) throw new Error('storage');
      events.push(`end-${request.matchId}`);
      return context;
    },
    onError(request, error) { failures.push([request.matchId, error.message]); },
    observe(event) { observations.push(event); },
  });
  const a = queue.enqueue({matchId: 'a'}, {}, 'series-a');
  const b = queue.enqueue({matchId: 'b'}, {fail: true}, 'series-b');
  const c = queue.enqueue({matchId: 'c'}, {}, 'series-c');
  assert.equal(await a, 'series-a'); await assert.rejects(b, /storage/);
  assert.equal(await c, 'series-c'); await queue.drain();
  assert.deepEqual(events, ['start-a', 'end-a', 'start-b', 'start-c', 'end-c']);
  assert.deepEqual(failures, [['b', 'storage']]);
  assert.equal(observations.length, 3);
  assert.ok(observations.every(event => event.durationMs >= 0));
});

test('timing diagnostics observe successful and failed persistence without altering it', async () => {
  const events = []; const diagnostic = createDiagnostics({onDiagnostic: event => events.push(event)});
  assert.equal(diagnostic.derive(() => 42)(), 42);
  await diagnostic.append(async () => 42)();
  await diagnostic.write(async () => {})('/tmp/checkpoint.json');
  await assert.rejects(diagnostic.request(async () => {throw new Error('network');})(), /network/);
  assert.deepEqual(events.map(event => event.operation), ['derived-artifact-compute', 'append-flush', 'checkpoint', 'request']);
  assert.equal(events[3].succeeded, false);
  assert.ok(events.every(event => event.heapUsedBytes > 0));
  const broken = createDiagnostics({onDiagnostic() {throw new Error('diagnostic');}});
  assert.equal(await broken.append(async () => 7)(), 7);
});
