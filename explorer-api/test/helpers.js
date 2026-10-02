'use strict';

const {cp, mkdtemp, mkdir, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');

const FIXTURE_RUN_ID = 'sample-32-002';
const SOURCE_RUN = resolve(
  __dirname,
  '../../evidence/tournaments/runs',
  FIXTURE_RUN_ID
);

async function createFixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), 'explorer-api-test-'));
  await mkdir(join(root, 'runs'), {recursive: true});
  await cp(SOURCE_RUN, join(root, 'runs', FIXTURE_RUN_ID), {recursive: true});
  return root;
}

async function removeFixtureRoot(root) {
  await rm(root, {recursive: true, force: true});
}

module.exports = {FIXTURE_RUN_ID, createFixtureRoot, removeFixtureRoot};
