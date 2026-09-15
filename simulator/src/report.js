'use strict';

const {randomUUID} = require('node:crypto');
const {open, rename, unlink} = require('node:fs/promises');
const {basename, dirname, join} = require('node:path');

const {loadTournamentArtifacts} = require('./report-loader');
const {renderReport} = require('./report-renderer');

async function atomicWriteText(filePath, contents, dependencies = {}) {
  const openImpl = dependencies.open === undefined ? open : dependencies.open;
  const renameImpl = dependencies.rename === undefined ? rename : dependencies.rename;
  const unlinkImpl = dependencies.unlink === undefined ? unlink : dependencies.unlink;
  const temporaryPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle;
  let ownsTemporary = false;

  try {
    handle = await openImpl(temporaryPath, 'wx');
    ownsTemporary = true;
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameImpl(temporaryPath, filePath);
    ownsTemporary = false;
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Preserve the write failure.
      }
    }
    if (ownsTemporary) {
      try {
        await unlinkImpl(temporaryPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError;
      }
    }
    throw error;
  }
}

async function generateReport(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Report options must be a non-array object');
  }
  const loadArtifacts = options.loadTournamentArtifacts === undefined
    ? loadTournamentArtifacts
    : options.loadTournamentArtifacts;
  const writeText = options.atomicWriteText === undefined
    ? atomicWriteText
    : options.atomicWriteText;
  const artifacts = await loadArtifacts({
    stateRoot: options.stateRoot,
    runId: options.runId,
  });
  const generatedAt = options.now === undefined
    ? new Date().toISOString()
    : options.now();
  const html = renderReport(artifacts, {
    generatedAt,
  });
  const outputPath = options.outputPath === undefined
    ? join(artifacts.runDirectory, 'report.html')
    : options.outputPath;
  await writeText(outputPath, html);
  return {
    outputPath,
    runDirectory: artifacts.runDirectory,
    acceptedResultCount: artifacts.uniqueResultCount,
    duplicateMatchIdCount: artifacts.duplicateMatchIdCount,
    generatedAt,
  };
}

module.exports = {
  atomicWriteText,
  generateReport,
};
