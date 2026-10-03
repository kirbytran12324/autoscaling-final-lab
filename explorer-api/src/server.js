'use strict';

const {createServer} = require('node:http');
const {access, stat} = require('node:fs/promises');
const {constants} = require('node:fs');
const {createApp} = require('./app');
const {FilesystemArtifactStore} = require('./artifact-store');
const {ReplayService, createReplayClient} = require('./replays');

function requiredStateRoot(environment = process.env) {
  const value = environment.TOURNAMENT_STATE_ROOT;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('TOURNAMENT_STATE_ROOT is required');
  }
  return value;
}

function startServer(environment = process.env) {
  const port = Number(environment.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const host = environment.HOST || '0.0.0.0';
  const stateRoot = requiredStateRoot(environment);
  const store = new FilesystemArtifactStore({stateRoot});
  const replays = new ReplayService({store, generate: createReplayClient({
    baseUrl: environment.SIMULATOR_BASE_URL || 'http://127.0.0.1:3000',
  })});
  const server = createServer(createApp({store, replays, readiness: async () => {
    await access(stateRoot, constants.R_OK);
    return (await stat(stateRoot)).isDirectory();
  }}));
  server.listen(port, host, () => {
    console.log(`Explorer API listening on http://${host}:${port}`);
  });
  return server;
}

if (require.main === module) {
  const server = startServer();
  const shutdown = () => {
    const deadline = setTimeout(() => process.exit(1), 25000);
    deadline.unref();
    server.close(() => { clearTimeout(deadline); process.exit(0); });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

module.exports = {requiredStateRoot, startServer};
