'use strict';

const {createServer} = require('node:http');
const {createApp} = require('./app');
const {FilesystemArtifactStore} = require('./artifact-store');

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
  const store = new FilesystemArtifactStore({stateRoot: requiredStateRoot(environment)});
  const server = createServer(createApp({store}));
  server.listen(port, host, () => {
    console.log(`Explorer API listening on http://${host}:${port}`);
  });
  return server;
}

if (require.main === module) startServer();

module.exports = {requiredStateRoot, startServer};
