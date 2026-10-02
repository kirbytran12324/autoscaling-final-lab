'use strict';

const {readFile} = require('node:fs/promises');
const {resolve} = require('node:path');
const {ArtifactStoreError} = require('../errors');
const {REPORT_FILE} = require('./contracts');
async function getReport(runId) {
    const artifacts = await this.loadCompletedRun(runId);
    if (!artifacts.hasReport) {
      throw new ArtifactStoreError(404, 'REPORT_NOT_FOUND', 'Offline report is not available.');
    }
    const runDirectory = this.resolveRunDirectory(runId);
    await this.assertSafeFile(runDirectory, REPORT_FILE);
    try {
      const body = await readFile(resolve(runDirectory, REPORT_FILE));
      return {
        body,
        size: body.length,
        fileName: `${runId}-report.html`,
        contentType: 'text/html; charset=utf-8',
      };
    } catch (error) {
      throw new ArtifactStoreError(
        500,
        'ARTIFACT_STORE_UNAVAILABLE',
        'Tournament artifacts are temporarily unavailable.',
        {cause: error}
      );
    }
  }
module.exports = {getReport};
