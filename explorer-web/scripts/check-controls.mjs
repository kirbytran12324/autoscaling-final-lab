// Production-build browser check with an isolated Kubernetes fixture. It never
// accesses a real cluster or starts a real tournament.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';

const require = createRequire(import.meta.url);
const {FakeKube, config, input} = require('../../control-api/test/helpers.js');
const {RunManager} = require('../../control-api/src/manager.js');
const {createApp} = require('../../control-api/src/app.js');
const {jobName} = require('../../control-api/src/jobs.js');
const token = 'browser-fixture-token-0000000000000000';
const kube = new FakeKube();
const manager = new RunManager(kube, config, {fetchImpl: async () => new Response(JSON.stringify({
  runId: input.runId, checkpoint: {stage: 'groups', round: null, acceptedResultCount: 10,
    updatedAt: '2026-10-09T00:00:00Z'}, standings: {status: 'provisional', updatedAt: '2026-10-09T00:00:00Z',
    groups: [{group: 'A', standings: [{rank: 1, species: 'Blastoise', speciesId: 'blastoise', played: 2, points: 6}]}]},
  events: [{type: 'battle-accepted', at: '2026-10-09T00:00:00Z', matchId: 'group-A-000001',
    pokemon1: 'Blastoise', pokemon2: 'Mew', outcome: 'win', turns: 7}],
}))});
const control = createApp({manager, token, maxConcurrency: config.maxConcurrency});
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const output = fileURLToPath(new URL('../../.validation/', import.meta.url));
const types = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html'};
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const server = createServer(async (request, response) => {
  if (request.url.startsWith('/api/control/')) return control(request, response);
  try {
    const url = new URL(request.url, 'http://fixture');
    if (url.pathname === '/runtime-config.js') {
      response.writeHead(200, {'content-type': 'application/javascript'});
      return response.end(`window.METRONOME_CONFIG={controlEnabled:true,showdownAssetBaseUrl:'http://${request.headers.host}/fixture/'};`);
    }
    if (url.pathname.startsWith('/fixture/sprites/')) {
      response.writeHead(200, {'content-type': 'image/png'}); return response.end(pixel);
    }
    const relative = url.pathname === '/' || url.pathname === '/operate' ? 'index.html' : url.pathname.slice(1);
    const target = path.resolve(root, relative);
    if (!target.startsWith(root)) {response.writeHead(404); return response.end();}
    const data = await readFile(target);
    response.writeHead(200, {'content-type': types[path.extname(target)] || 'application/octet-stream'});
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({headless: true,
    ...(process.env.CONTROL_CHECK_BROWSER ? {channel: process.env.CONTROL_CHECK_BROWSER} : {})});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  assert.equal((await fetch(base + '/api/control/runs')).status, 401);
  await page.goto(base + '/operate');
  await page.getByLabel('Operator token').fill('invalid');
  await page.getByRole('button', {name: 'Unlock controls'}).click();
  await page.getByRole('alert').filter({hasText: 'valid operator token'}).waitFor();
  await page.getByLabel('Operator token').fill(token);
  await page.getByRole('button', {name: 'Unlock controls'}).click();
  await page.getByLabel('Run ID', {exact: true}).fill(input.runId);
  await page.getByLabel('Seed', {exact: true}).fill(input.seed);
  await page.getByRole('button', {name: 'Create tournament'}).click();
  await page.getByRole('heading', {name: input.runId, exact: true}).waitFor();
  await kube.create('pods', {metadata: {name: 'fixture-pod', labels: {'job-name': jobName(input.runId)}}, status: {phase: 'Running'}});
  await manager.reconcile();
  await page.getByRole('heading', {name: 'Preliminary group standings'}).waitFor();
  await page.getByText('Blastoise', {exact: true}).waitFor();
  await page.getByRole('button', {name: 'Pause', exact: true}).click();
  await page.getByRole('status').filter({hasText: 'Pausing'}).waitFor();
  const pod = await kube.get('pods', 'fixture-pod');
  await kube.delete('pods', 'fixture-pod', pod.metadata); await manager.reconcile();
  await page.getByRole('button', {name: 'Resume', exact: true}).click();
  await kube.create('pods', {metadata: {name: 'resumed-fixture-pod', labels: {'job-name': jobName(input.runId)}}, status: {phase: 'Running'}});
  await manager.reconcile();
  await page.getByRole('button', {name: 'Pause', exact: true}).waitFor();
  await page.getByRole('heading', {name: 'Preliminary group standings'}).waitFor();
  await mkdir(output, {recursive: true});
  await page.screenshot({path: path.join(output, 'controls-desktop.png'), fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({path: path.join(output, 'controls-mobile.png'), fullPage: true});
  await kube.condition(jobName(input.runId), 'Complete'); await manager.reconcile(); await manager.reconcile();
  await kube.condition(jobName(input.runId, 'publish'), 'Complete'); await manager.reconcile();
  await page.getByRole('button', {name: 'Explore completed run'}).waitFor();
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  await page.getByRole('button', {name: 'Lock controls'}).click();
  assert.equal(await page.getByLabel('Operator token').inputValue(), '');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({verified: true, authentication: true, creation: true, progress: true,
    pauseResume: true, publication: true, desktop: true, mobile: true, errors}));
} finally {
  try { await browser?.close(); }
  finally { await new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}); }
}
