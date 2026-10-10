'use strict';

const {createServer} = require('node:http');
const {timingSafeEqual} = require('node:crypto');
const {readFile} = require('node:fs/promises');
const {join} = require('node:path');
const {resolveRunDirectory} = require('../runner-state');

function matchesToken(header, token) {
  const actual = Buffer.from(header || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function startStatusServer({configuration, token, port, host = '0.0.0.0', state}) {
  if (!token || token.length < 32) throw new Error('RUNNER_STATUS_TOKEN must contain at least 32 characters');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid RUNNER_STATUS_PORT');
  const runDirectory = resolveRunDirectory(configuration.stateRoot, configuration.identity.runId);
  async function artifact(name) {
    try { return JSON.parse(await readFile(join(runDirectory, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  const server = createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});
      response.end(JSON.stringify(value));
    };
    if (!matchesToken(request.headers.authorization, token)) return send(401, {error: 'Unauthorized'});
    if (request.method !== 'GET' || request.url !== '/status') return send(404, {error: 'Not found'});
    try {
      const [metadata, checkpoint, standings, bracket] = await Promise.all([
        artifact('run-metadata.json'), artifact('checkpoint.json'), artifact('standings.json'), artifact('bracket.json'),
      ]);
      send(200, {runId: configuration.identity.runId, stopping: state.stopping,
        metadata, checkpoint, standings, bracket, events: state.events});
    } catch { send(503, {error: 'Progress snapshot unavailable'}); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

module.exports = {startStatusServer, matchesToken};
