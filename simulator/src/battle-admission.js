'use strict';

class SimulatorBusyError extends Error {
  constructor() {
    super('Simulator capacity is full. Retry the same battle shortly.');
    this.code = 'SIMULATOR_BUSY';
  }
}

// Each replica owns only its local admission budget. Scheduling and battle
// identity remain the runner's responsibility, including after HTTP retries.
function createBattleAdmission({maxConcurrent = 2, maxQueued = 8} = {}) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 ||
      !Number.isSafeInteger(maxQueued) || maxQueued < 0) {
    throw new TypeError('Battle concurrency must be positive and queue size non-negative integers');
  }
  let active = 0;
  const queue = [];

  function start(job) {
    active++;
    // Yield between batches so queued work does not continually extend the
    // battle engine's microtask chain ahead of HTTP health requests.
    setImmediate(async () => {
      try {
        if (!job.cancelled) job.resolve(await job.invoke());
      } catch (error) {
        job.reject(error);
      } finally {
        job.cleanup();
        active--;
        while (queue.length && active < maxConcurrent) start(queue.shift());
      }
    });
  }

  return {
    get available() { return active < maxConcurrent || queue.length < maxQueued; },
    run(invoke, {signal} = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (active >= maxConcurrent && queue.length >= maxQueued) {
        return Promise.reject(new SimulatorBusyError());
      }
      return new Promise((resolve, reject) => {
        const job = {invoke, resolve, reject, cancelled: false,
          cleanup: () => signal?.removeEventListener('abort', cancel)};
        function cancel() {
          job.cancelled = true;
          const index = queue.indexOf(job);
          if (index !== -1) queue.splice(index, 1);
          job.cleanup();
          reject(signal.reason);
        }
        signal?.addEventListener('abort', cancel, {once: true});
        if (active < maxConcurrent) start(job);
        else queue.push(job);
      });
    },
  };
}

module.exports = {createBattleAdmission, SimulatorBusyError};
