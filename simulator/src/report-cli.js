'use strict';

const {generateReport} = require('./report');
const {resolveRunDirectory} = require('./runner-state');

function requiredEnvironment(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} is required and must be non-empty`);
  }
  return value.trim();
}

function parseReportConfiguration(env) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('Environment must be an object');
  }
  const stateRoot = requiredEnvironment(env, 'TOURNAMENT_STATE_ROOT');
  const runId = requiredEnvironment(env, 'TOURNAMENT_RUN_ID');
  resolveRunDirectory(stateRoot, runId);
  return {
    stateRoot,
    runId,
    restartEvidenceDirectory: env.REPORT_RESTART_EVIDENCE_DIR === undefined
      ? undefined
      : requiredEnvironment(env, 'REPORT_RESTART_EVIDENCE_DIR'),
    autoscalingEvidenceDirectory: env.REPORT_AUTOSCALING_EVIDENCE_DIR === undefined
      ? undefined
      : requiredEnvironment(env, 'REPORT_AUTOSCALING_EVIDENCE_DIR'),
  };
}

async function runCli(options = {}) {
  const env = options.env === undefined ? process.env : options.env;
  const args = options.args === undefined ? process.argv.slice(2) : options.args;
  const stdout = options.stdout === undefined ? console.log : options.stdout;
  const stderr = options.stderr === undefined ? console.error : options.stderr;
  const generateReportImpl = options.generateReportImpl === undefined
    ? generateReport
    : options.generateReportImpl;

  if (!Array.isArray(args) || args.length !== 0) {
    stderr('Report configuration error: command-line arguments are not supported');
    return 1;
  }

  let configuration;
  try {
    configuration = parseReportConfiguration(env);
  } catch (error) {
    stderr(`Report configuration error: ${error.message}`);
    return 1;
  }

  try {
    const summary = await generateReportImpl(configuration);
    stdout(
      `Report generated: runId=${configuration.runId} ` +
      `results=${summary.acceptedResultCount} output=${summary.outputPath}`
    );
    return 0;
  } catch (error) {
    stderr(`Report generation failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  runCli().then(exitCode => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  parseReportConfiguration,
  runCli,
};
