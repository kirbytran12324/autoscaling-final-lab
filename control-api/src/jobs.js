'use strict';

function jobName(runId, kind = 'runner', attempt = 1) { return `mt-${kind}-${runId}-${attempt}`; }

function buildJob(run, config, kind = 'runner', attempt = 1) {
  const publisher = kind === 'publish';
  const labels = {'app.kubernetes.io/managed-by': 'metronome-control',
    'metronome.run-id': run.runId, 'metronome.kind': kind};
  const env = {TOURNAMENT_RUN_ID: run.runId, TOURNAMENT_MODE: run.mode,
    TOURNAMENT_SEED: run.seed, RUNNER_CONCURRENCY: String(run.concurrency),
    TOURNAMENT_STATE_ROOT: '/state', SIMULATOR_BASE_URL: config.simulatorUrl,
    RULES_VERSION: config.rulesVersion, SIMULATOR_VERSION: config.simulatorVersion,
    SIMULATOR_IMAGE: config.image};
  if (publisher) env.TOURNAMENT_ARCHIVE_ROOT = '/archive';
  else env.RUNNER_STATUS_PORT = String(config.statusPort);
  const container = {name: kind, image: config.image, imagePullPolicy: 'IfNotPresent',
    command: ['node'], args: [publisher ? 'src/publish-cli.js' : 'src/runner-cli.js'],
    env: Object.entries(env).map(([name, value]) => ({name, value})),
    securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
      capabilities: {drop: ['ALL']}},
    resources: {requests: {cpu: '100m', memory: '128Mi'}, limits: {cpu: '1', memory: '1Gi'}},
    volumeMounts: [{name: 'state', mountPath: '/state', readOnly: publisher}]};
  const volumes = [{name: 'state', persistentVolumeClaim: {claimName: config.stateClaim, readOnly: publisher}}];
  if (publisher) {
    container.volumeMounts.push({name: 'archive', mountPath: '/archive'});
    volumes.push({name: 'archive', persistentVolumeClaim: {claimName: config.archiveClaim}});
  } else {
    container.env.push({name: 'RUNNER_STATUS_TOKEN', valueFrom: {
      secretKeyRef: {name: config.secretName, key: 'runner-status-token'}}});
    container.ports = [{name: 'status', containerPort: config.statusPort}];
  }
  return {apiVersion: 'batch/v1', kind: 'Job', metadata: {name: jobName(run.runId, kind, attempt),
    namespace: config.namespace, labels}, spec: {completions: 1, parallelism: 1,
    suspend: !publisher, backoffLimit: 2, podReplacementPolicy: 'Failed',
    template: {metadata: {labels}, spec: {restartPolicy: 'Never',
      automountServiceAccountToken: false, terminationGracePeriodSeconds: 180,
      securityContext: {runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000,
        fsGroup: 1000, seccompProfile: {type: 'RuntimeDefault'}}, containers: [container], volumes}}}};
}

module.exports = {buildJob, jobName};
