'use strict';
const {createServer} = require('node:http');
const {readConfig} = require('./config');
const {KubernetesClient} = require('./kubernetes');
const {RunManager, SLOT} = require('./manager');
const {createApp} = require('./app');

function startServer(config = readConfig()) {
  const kube = new KubernetesClient(config.namespace);
  const manager = new RunManager(kube, config);
  const reconcile = () => manager.reconcile().catch(error => console.error('Run reconciliation failed', {code: error.code || 'CONTROL_UNAVAILABLE'}));
  const timer = setInterval(reconcile, 3000);
  timer.unref();
  const server = createServer(createApp({manager, token: config.operatorToken,
    maxConcurrency: config.maxConcurrency,
    readiness: async () => { try { await kube.get('configmaps', SLOT); return true; } catch { return false; } }}));
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(config.port, config.host, () => { console.log(`Control API listening on ${config.port}`); reconcile(); });
  server.on('close', () => clearInterval(timer));
  return server;
}
if (require.main === module) {
  try {
    const server = startServer();
    const stop = () => server.close(() => process.exit(0));
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch (error) { console.error(`Control configuration error: ${error.message}`); process.exitCode = 1; }
}
module.exports = {startServer};
