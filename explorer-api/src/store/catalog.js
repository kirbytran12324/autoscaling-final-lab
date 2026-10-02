'use strict';

const {readdir} = require('node:fs/promises');
const {ArtifactStoreError} = require('../errors');
const {RUN_ID_PATTERN} = require('./contracts');
const {toSummary, toRunDetail} = require('./projections');
async function listRuns() {
    let entries;
    try {
      entries = await readdir(this.runsRoot, {withFileTypes: true});
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new ArtifactStoreError(
        500,
        'ARTIFACT_STORE_UNAVAILABLE',
        'Tournament artifacts are temporarily unavailable.',
        {cause: error}
      );
    }

    const summaries = [];
    const candidates = entries
      .filter(entry => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
      .map(entry => entry.name)
      .sort();
    for (const runId of candidates) {
      try {
        const runDirectory = await this.assertSafeRunDirectory(runId);
        const signature = await this.canonicalSignature(runDirectory);
        const cached = this.summaryCache.get(runId);
        if (cached && cached.signature === signature) {
          summaries.push(cached.summary);
        } else {
          summaries.push(toSummary(await this.loadCompletedRun(runId)));
        }
      } catch (error) {
        if (!(error instanceof ArtifactStoreError) || error.status >= 500) throw error;
      }
    }
    return summaries.sort((left, right) =>
      right.completedAt.localeCompare(left.completedAt) ||
      left.runId.localeCompare(right.runId)
    );
  }

async function getRun(runId) {
    return toRunDetail(await this.loadCompletedRun(runId));
  }

async function getBracket(runId) {
    return (await this.loadCompletedRun(runId)).bracket;
  }
module.exports = {listRuns, getRun, getBracket};
