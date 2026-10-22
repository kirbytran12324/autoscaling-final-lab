'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const {createBattleAdmission} = require('../src/battle-admission');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('admission bounds work, rejects overload, and recovers in FIFO order', async () => {
  const admission = createBattleAdmission({maxConcurrent: 1, maxQueued: 1});
  const started = [];
  let finish;
  const first = admission.run(() => {
    started.push('first');
    return new Promise(resolve => { finish = resolve; });
  });
  const second = admission.run(() => { started.push('second'); return 2; });
  assert.equal(admission.available, false);
  await assert.rejects(admission.run(() => assert.fail('overload executed')),
    error => error.code === 'SIMULATOR_BUSY');
  await tick();
  assert.deepEqual(started, ['first']);
  finish(1);
  assert.equal(await first, 1);
  assert.equal(await second, 2);
  assert.deepEqual(started, ['first', 'second']);
  assert.equal(admission.available, true);
  assert.equal(await admission.run(() => 3), 3);
});

test('cancelled queued work is removed, and failure releases its active slot', async () => {
  const admission = createBattleAdmission({maxConcurrent: 1, maxQueued: 1});
  const controller = new AbortController();
  let finish;
  const first = admission.run(() => new Promise(resolve => { finish = resolve; }));
  const queued = admission.run(() => assert.fail('cancelled work executed'),
    {signal: controller.signal});
  controller.abort();
  await assert.rejects(queued, {name: 'AbortError'});
  assert.equal(admission.available, true);
  const failure = new Error('engine failure');
  const next = admission.run(() => { throw failure; });
  const rejected = assert.rejects(next, error => error === failure);
  await tick();
  finish();
  await first;
  await rejected;
  assert.equal(await admission.run(() => 'recovered'), 'recovered');
});

test('admission validates limits and never invokes already aborted work', async () => {
  for (const limits of [{maxConcurrent: 0}, {maxConcurrent: 1.5}, {maxQueued: -1}]) {
    assert.throws(() => createBattleAdmission(limits), TypeError);
  }
  const controller = new AbortController();
  controller.abort();
  const admission = createBattleAdmission({maxQueued: 0});
  await assert.rejects(admission.run(() => assert.fail('aborted work executed'),
    {signal: controller.signal}), {name: 'AbortError'});
});
