'use strict';

const {loadTournamentArtifacts} = require('../../../simulator/src/report-loader');
const {ArtifactAccess} = require('./access');
const {ArtifactStoreError} = require('../errors');
const {REPORT_FILE} = require('./contracts');
const {buildMatchContext} = require('./context');
const {toSummary} = require('./projections');
class RunCache extends ArtifactAccess {
  constructor(options) {
    super(options);
    this.loadArtifacts = options.loadTournamentArtifacts || loadTournamentArtifacts;
    this.cachedRun = null;
    this.pendingLoads = new Map();
    this.loadTail = Promise.resolve();
    this.summaryCache = new Map();
  }
async loadCompletedRun(runId) {
    const runDirectory = await this.assertSafeRunDirectory(runId);
    const signature = await this.canonicalSignature(runDirectory);
    if (this.cachedRun && this.cachedRun.runId === runId &&
        this.cachedRun.signature === signature) {
      return this.cachedRun.artifacts;
    }

    const key = `${runId}\0${signature}`;
    if (this.pendingLoads.has(key)) return this.pendingLoads.get(key);

    // Share every pending run while admitting only one heavyweight load at a time.
    const promise = this.loadTail.then(() => {
      this.cachedRun = null;
      return this.loadAndCacheRun(runId, runDirectory, signature);
    });
    this.pendingLoads.set(key, promise);
    this.loadTail = promise.then(() => undefined, () => undefined);
    try {
      return await promise;
    } finally {
      if (this.pendingLoads.get(key) === promise) this.pendingLoads.delete(key);
    }
  }

async loadAndCacheRun(runId, runDirectory, signature) {
    let artifacts;
    try {
      artifacts = await this.loadArtifacts({stateRoot: this.stateRoot, runId});
    } catch (error) {
      let failure = error;
      const visited = new Set();
      let unavailable = false;
      while (failure && !visited.has(failure)) {
        visited.add(failure);
        if (failure.code && failure.code !== 'ENOENT' &&
            (failure.syscall || /^(EIO|EACCES|EPERM|EMFILE|ENFILE|ENOSPC|EROFS|ENODEV|ESTALE|ETIMEDOUT)$/.test(failure.code))) {
          unavailable = true;
        }
        failure = failure.cause;
      }
      throw new ArtifactStoreError(
        unavailable ? 500 : 422,
        unavailable ? 'ARTIFACT_STORE_UNAVAILABLE' : 'INVALID_RUN',
        unavailable ? 'Tournament artifacts are temporarily unavailable.' :
          'Tournament run is invalid or incomplete.',
        {cause: error}
      );
    }
    artifacts.hasReport = (await this.assertSafeFile(
      runDirectory,
      REPORT_FILE,
      {required: false}
    )) !== null;
    artifacts.matchContext = buildMatchContext(artifacts);
    this.cachedRun = {runId, signature, artifacts};
    this.summaryCache.set(runId, {signature, summary: toSummary(artifacts)});
    return artifacts;
  }
}
module.exports = {RunCache};
