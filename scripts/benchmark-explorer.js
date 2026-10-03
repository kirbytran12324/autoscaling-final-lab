#!/usr/bin/env node
'use strict';

const {performance, monitorEventLoopDelay} = require('node:perf_hooks');
const {resolve} = require('node:path');
const {FilesystemArtifactStore} = require('../explorer-api/src/artifact-store');
const stateRoot = resolve(process.argv[2] || 'evidence/tournaments');
const runId = process.argv[3] || 'full-1025-002';
const sampleCount = 30;
async function main() {
  const delay = monitorEventLoopDelay({resolution: 10}); delay.enable();
  const store = new FilesystemArtifactStore({stateRoot});
  const started = performance.now();
  const artifacts = await store.loadCompletedRun(runId);
  const coldLoadMs = performance.now() - started;
  const first = performance.now();
  const initialPage = await store.listMatches(runId, {limit: 25});
  const firstPageMs = performance.now() - first;
  const coldEventLoopMaxDelayMs = delay.max / 1e6;
  delay.reset();
  const durations = [];
  let cursor = initialPage.nextCursor;
  for (let sample = 0; sample < sampleCount; sample++) {
    const tick = performance.now();
    const page = await store.listMatches(runId, {limit: 25, cursor});
    durations.push(performance.now() - tick);
    cursor = page.nextCursor || undefined;
  }
  durations.sort((a, b) => a - b);
  delay.disable();
  const warmP95Ms = durations[Math.ceil(sampleCount * 0.95) - 1];
  console.log(JSON.stringify({runId, runtime: process.version, matches: artifacts.uniqueResultCount,
    coldLoadMs, firstPageMs, warmPageSamples: sampleCount, warmP95Ms,
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
    retainedRssMiB: process.memoryUsage().rss / (1024 * 1024),
    coldEventLoopMaxDelayMs, warmEventLoopMaxDelayMs: delay.max / 1e6}, null, 2));
  if (warmP95Ms >= 250) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
