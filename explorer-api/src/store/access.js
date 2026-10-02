'use strict';

const {lstat} = require('node:fs/promises');
const {resolve, sep} = require('node:path');
const {REQUIRED_FILES} = require('../../../simulator/src/report-loader');
const {ArtifactStoreError} = require('../errors');
const {validateRunId, OPTIONAL_FILES} = require('./contracts');
function signatureFromStats(stats) {
  return stats.map(value => `${value.size}:${value.mtimeMs}`).join('|');
}
class ArtifactAccess {
  constructor(options) {
    if (!options || typeof options.stateRoot !== 'string' || options.stateRoot.trim() === '') throw new TypeError('stateRoot must be a non-empty string');
    this.stateRoot = resolve(options.stateRoot);
    this.runsRoot = resolve(this.stateRoot, 'runs');
  }
resolveRunDirectory(runId) {
    validateRunId(runId);
    const candidate = resolve(this.runsRoot, runId);
    if (candidate !== this.runsRoot && !candidate.startsWith(`${this.runsRoot}${sep}`)) {
      throw new ArtifactStoreError(400, 'INVALID_RUN_ID', 'Run ID is invalid.');
    }
    return candidate;
  }

async assertSafeRunDirectory(runId) {
    const runDirectory = this.resolveRunDirectory(runId);
    let info;
    try {
      info = await lstat(runDirectory);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new ArtifactStoreError(404, 'RUN_NOT_FOUND', 'Tournament run was not found.');
      }
      throw new ArtifactStoreError(
        500,
        'ARTIFACT_STORE_UNAVAILABLE',
        'Tournament artifacts are temporarily unavailable.',
        {cause: error}
      );
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ArtifactStoreError(404, 'RUN_NOT_FOUND', 'Tournament run was not found.');
    }
    return runDirectory;
  }

async assertSafeFile(runDirectory, fileName, {required = true} = {}) {
    const path = resolve(runDirectory, fileName);
    if (!path.startsWith(`${runDirectory}${sep}`)) {
      throw new ArtifactStoreError(500, 'UNSAFE_ARTIFACT', 'Tournament artifact is unsafe.');
    }
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new ArtifactStoreError(422, 'INVALID_RUN', 'Tournament run is invalid or incomplete.');
      }
      return info;
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      if (error.code === 'ENOENT' && !required) return null;
      if (error.code === 'ENOENT') {
        throw new ArtifactStoreError(422, 'INVALID_RUN', 'Tournament run is invalid or incomplete.');
      }
      throw new ArtifactStoreError(
        500,
        'ARTIFACT_STORE_UNAVAILABLE',
        'Tournament artifacts are temporarily unavailable.',
        {cause: error}
      );
    }
  }

async canonicalSignature(runDirectory) {
    const stats = [];
    for (const fileName of REQUIRED_FILES) {
      stats.push(await this.assertSafeFile(runDirectory, fileName));
    }
    for (const fileName of OPTIONAL_FILES) {
      const info = await this.assertSafeFile(runDirectory, fileName, {required: false});
      if (info !== null) stats.push(info);
    }
    return signatureFromStats(stats);
  }
}
module.exports = {ArtifactAccess};
