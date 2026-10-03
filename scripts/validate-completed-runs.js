#!/usr/bin/env node
'use strict';

const {readdirSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {loadTournamentArtifacts} = require('../simulator/src/report-loader');
const {DETERMINISTIC_RESULT_FIELDS} = require('../simulator/src/state/constants');

async function main() {
  const stateRoot = resolve(process.argv[2] || 'evidence/tournaments');
  const runId = process.argv[3];
  if (!runId) {
    // Separate processes bound memory across full runs without changing artifacts.
    for (const entry of readdirSync(join(stateRoot, 'runs'), {withFileTypes: true}).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const result = spawnSync(process.execPath, [__filename, stateRoot, entry.name], {stdio: 'inherit'});
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Validation failed for ${entry.name}`);
    }
    return;
  }
  const artifacts = await loadTournamentArtifacts({stateRoot, runId});
  const deterministic = createHash('sha256');
  for (const result of [...artifacts.results].sort((a, b) => a.matchId.localeCompare(b.matchId))) {
    deterministic.update(JSON.stringify(DETERMINISTIC_RESULT_FIELDS.map(field => result[field])) + '\n');
  }
  console.log(JSON.stringify({runId, results: artifacts.uniqueResultCount,
    champion: artifacts.champion.champion.species, rosterHash: artifacts.roster.rosterHash,
    deterministicResultsSha256: deterministic.digest('hex')}));
}
main().catch(error => {console.error(error); process.exitCode = 1;});
