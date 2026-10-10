'use strict';

const {createHash} = require('node:crypto');
const {mkdir, mkdtemp, readFile, copyFile, rename, rm, writeFile, lstat} = require('node:fs/promises');
const {join, resolve} = require('node:path');
const {loadTournamentArtifacts} = require('./artifacts/loader');
const {generateReport} = require('./report');

async function fingerprints(directory, files) {
  return Object.fromEntries(await Promise.all(files.map(async name => [name,
    createHash('sha256').update(await readFile(join(directory, name))).digest('hex')])));
}

async function publishRun({stateRoot, archiveRoot, runId}) {
  if (resolve(stateRoot) === resolve(archiveRoot)) throw new Error('Active state and archive roots must differ');
  const source = await loadTournamentArtifacts({stateRoot, runId});
  if (source.duplicateMatchIdCount !== 0) throw new Error('Publication requires unique accepted results');
  const hashes = await fingerprints(source.runDirectory, source.sourceFiles);
  const runs = join(archiveRoot, 'runs');
  const destination = join(runs, runId);
  await mkdir(runs, {recursive: true});
  async function verifyExisting() {
    await loadTournamentArtifacts({stateRoot: archiveRoot, runId});
    const existing = await fingerprints(destination, source.sourceFiles);
    if (JSON.stringify(existing) !== JSON.stringify(hashes)) throw new Error('Archive already exists with different evidence');
    return {runId, archived: true, existing: true, checkpoint: source.checkpoint};
  }
  try { await lstat(destination); return await verifyExisting(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = join(archiveRoot, 'staging');
  await mkdir(staging, {recursive: true});
  const temporary = await mkdtemp(join(staging, 'publish-'));
  try {
    const stagedRun = join(temporary, 'runs', runId);
    await mkdir(stagedRun, {recursive: true});
    for (const name of source.sourceFiles) await copyFile(join(source.runDirectory, name), join(stagedRun, name));
    await loadTournamentArtifacts({stateRoot: temporary, runId});
    const copied = await fingerprints(stagedRun, source.sourceFiles);
    if (JSON.stringify(copied) !== JSON.stringify(hashes)) throw new Error('Source evidence changed during publication');
    await generateReport({stateRoot: temporary, runId, now: () => source.metadata.completedAt});
    await writeFile(join(stagedRun, 'publication.json'), JSON.stringify({runId, hashes}) + '\n', {flag: 'wx'});
    // A single publisher owns the RWOP state disk. Existing nonempty archives
    // cannot be replaced by a directory rename; other writers must use this same contract.
    try { await rename(stagedRun, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      return await verifyExisting();
    }
    return {runId, archived: true, existing: false, checkpoint: source.checkpoint};
  } finally { await rm(temporary, {recursive: true, force: true}); }
}

if (require.main === module) {
  publishRun({stateRoot: process.env.TOURNAMENT_STATE_ROOT,
    archiveRoot: process.env.TOURNAMENT_ARCHIVE_ROOT, runId: process.env.TOURNAMENT_RUN_ID})
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(`Archive publication failed: ${error.message}`); process.exitCode = 1; });
}

module.exports = {publishRun};
