// Verify the production Nginx image. The control backend uses in-memory
// Kubernetes fixtures; no cluster, credentials, host ports or tournament data.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';

const execute = promisify(execFile);
const image = process.argv[2];
assert.ok(image && !image.startsWith('-'), 'Provide the web image tag or digest');
const root = fileURLToPath(new URL('../', import.meta.url));
const suffix = randomUUID();
const network = `metronome-web-check-${suffix}`;
const backend = `metronome-proxy-check-${suffix}`;
const archiveWeb = `metronome-archive-check-${suffix}`;
const controlWeb = `metronome-control-web-check-${suffix}`;
const containers = [];
let networkCreated = false;

async function docker(args, allowFailure = false) {
  try { return await execute('docker', args, {timeout: 60000, maxBuffer: 8 * 1024 * 1024}); }
  catch (error) {
    if (allowFailure && typeof error.code === 'number') return error;
    throw error;
  }
}

async function start(name, args) {
  // Keep exited containers available for failure logs; finally removes them.
  await docker(['run', '--detach', '--name', name, ...args]);
  containers.push(name);
}

async function request(name, route, headers = [], body) {
  const args = ['exec', name, 'wget', '-S', '-O', '-'];
  for (const header of headers) args.push('--header', header);
  if (body !== undefined) args.push('--post-data', body);
  args.push(`http://127.0.0.1:8080${route}`);
  const result = await docker(args, true);
  const status = Number(result.stderr.match(/HTTP\/1\.[01] (\d{3})/)?.[1]);
  return {status, body: result.stdout, headers: result.stderr};
}

async function ready(name) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const running = await docker(['inspect', '--format', '{{.State.Running}}', name]);
    assert.equal(running.stdout.trim(), 'true', `Nginx exited before readiness: ${name}`);
    if ((await request(name, '/health/ready')).status === 200) return;
    await delay(250);
  }
  throw new Error(`Nginx did not become ready: ${name}`);
}

const fixture = `
  const {createServer} = require('node:http');
  const {createApp} = require('/fixture/control-api/src/app');
  const {RunManager} = require('/fixture/control-api/src/manager');
  const {FakeKube, config} = require('/fixture/control-api/test/helpers');
  const manager = new RunManager(new FakeKube(), config,
    {fetchImpl: async () => { throw new Error('Isolated fixture'); }});
  createServer(createApp({manager, token: 'proxy-fixture-token-0000000000000000',
    maxConcurrency: 16})).listen(3002, '0.0.0.0');
`;

try {
  // The default image must start without a control Service or proxy mount.
  await start(archiveWeb, ['--read-only', '--tmpfs', '/tmp', '--network', 'none',
    '--add-host', 'metronome-explorer-api:127.0.0.1', image]);
  await ready(archiveWeb);
  await docker(['exec', archiveWeb, 'nginx', '-t']);
  const index = await request(archiveWeb, '/');
  assert.equal(index.status, 200);
  assert.match(index.body, /id="root"/);
  assert.equal((await request(archiveWeb, '/operate')).body, index.body);
  const assets = [...index.body.matchAll(/(?:src|href)="(\/assets\/[^"\s]+)"/g)]
    .map(match => match[1]);
  assert.ok(assets.some(asset => asset.endsWith('.js')));
  assert.ok(assets.some(asset => asset.endsWith('.css')));
  for (const asset of assets) {
    const response = await request(archiveWeb, asset);
    assert.equal(response.status, 200, asset);
    assert.ok(response.body.length > 0, asset);
  }
  const runtime = await request(archiveWeb, '/runtime-config.js');
  assert.equal(runtime.status, 200);
  assert.match(runtime.body, /METRONOME_CONFIG/);
  assert.match(runtime.headers, /cache-control:\s*no-store/i);
  const player = await request(archiveWeb, '/showdown/player.html');
  assert.equal(player.status, 200);
  assert.match(player.headers, /content-security-policy:.*frame-ancestors 'self'/i);
  const playerAssets = [...player.body.matchAll(/(?:src|href)="([^"\s]+\.(?:js|css))"/g)]
    .map(match => `/showdown/${match[1]}`);
  assert.ok(playerAssets.includes('/showdown/vendor/engine.js'));
  for (const asset of playerAssets) assert.equal((await request(archiveWeb, asset)).status, 200, asset);

  // A private Docker network connects only this fixture and the web image.
  await docker(['network', 'create', '--internal', network]);
  networkCreated = true;
  await start(backend, ['--read-only', '--tmpfs', '/tmp', '--network', network,
    '--network-alias', 'metronome-control-api', '--mount',
    `type=bind,source=${path.join(root, 'control-api')},target=/fixture/control-api,readonly`,
    'node:24.20.0-bookworm-slim', 'node', '-e', fixture]);
  await start(controlWeb, ['--read-only', '--tmpfs', '/tmp', '--network', network,
    '--add-host', 'metronome-explorer-api:127.0.0.1', '--mount',
    `type=bind,source=${path.join(root, 'explorer-web/control-proxy.conf')},target=/etc/nginx/control.d/control.conf,readonly`,
    image]);
  await ready(controlWeb);
  const auth = 'Authorization: Bearer proxy-fixture-token-0000000000000000';
  // Nginx readiness does not imply that the separate Node fixture is listening.
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await request(controlWeb, '/api/control/runs')).status === 401) break;
    await delay(250);
  }
  assert.equal((await request(controlWeb, '/api/control/runs')).status, 401);
  assert.equal((await request(controlWeb, '/api/control/runs',
    [auth, 'Origin: http://attacker.invalid'])).status, 403);
  const created = await request(controlWeb, '/api/control/runs',
    [auth, 'Origin: http://127.0.0.1:8080', 'Content-Type: application/json'],
    JSON.stringify({runId: 'proxy-check', mode: 'sample', seed: 'proxy-fixture', concurrency: 1}));
  assert.equal(created.status, 202, created.body);
  assert.equal(JSON.parse(created.body).run.runId, 'proxy-check');
  console.log(JSON.stringify({verified: true, nginx: true, readOnly: true,
    frontendAssets: assets.length, playerAssets: playerAssets.length,
    controlProxy: true, missingAuth: 401, foreignOrigin: 403, sameOriginWithPort: 202,
    kubernetes: 'simulated'}));
} catch (error) {
  for (const name of containers) {
    const logs = await docker(['logs', name], true).catch(() => null);
    if (logs) console.error(`${name}:\n${logs.stdout}${logs.stderr}`);
  }
  throw error;
} finally {
  const failures = [];
  for (const name of containers.reverse()) {
    try { await docker(['rm', '--force', name]); }
    catch (error) { failures.push(error); }
  }
  if (networkCreated) {
    try { await docker(['network', 'rm', network]); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Verification cleanup failed');
}
