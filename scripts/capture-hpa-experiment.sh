#!/usr/bin/env bash

set -uo pipefail
umask 077

# shellcheck source=lib/capture-common.sh
source "${BASH_SOURCE[0]%/*}/lib/capture-common.sh"
# shellcheck source=lib/hpa-guards.sh
source "${BASH_SOURCE[0]%/*}/lib/hpa-guards.sh"
# shellcheck source=lib/hpa-status.sh
source "${BASH_SOURCE[0]%/*}/lib/hpa-status.sh"
# shellcheck source=lib/hpa-sampling.sh
source "${BASH_SOURCE[0]%/*}/lib/hpa-sampling.sh"

readonly simulator_namespace="autoscaling-lab"
readonly simulator_deployment="metronome-simulator"
readonly simulator_service="metronome-simulator"
readonly simulator_hpa="metronome-simulator"
readonly simulator_selector="app=metronome-simulator"
readonly simulator_container="simulator"
readonly locust_namespace="load-testing"
readonly locust_deployment="metronome-load-test"
readonly locust_selector="app=metronome-load-test"
readonly locust_container="locust"
readonly kubectl_timeout_seconds=15

output_dir="${1:-}"
experiment_id="${EXPERIMENT_ID:-}"
duration="${CAPTURE_DURATION_SECONDS:-}"
interval="${SAMPLE_INTERVAL_SECONDS:-15}"
evidence_locust_users="${EVIDENCE_LOCUST_USERS:-}"
evidence_locust_spawn_rate="${EVIDENCE_LOCUST_SPAWN_RATE:-}"
evidence_locust_run_seconds="${EVIDENCE_LOCUST_RUN_SECONDS:-}"
allow_dirty_worktree="${ALLOW_DIRTY_WORKTREE:-0}"

work_dir=""
capture_started=0
capture_finished=0
capture_start_timestamp=""
sample_count=0
successful_sample_count=0
failed_sample_count=0
signal_name=""
final_validation_status="not-run"
final_collection_status="not-run"

usage() {
  cat >&2 <<'EOF'
Usage: EXPERIMENT_ID=<unique-name> \
       EVIDENCE_LOCUST_USERS=<non-negative-integer> \
       EVIDENCE_LOCUST_SPAWN_RATE=<non-negative-integer> \
       EVIDENCE_LOCUST_RUN_SECONDS=<non-negative-integer> \
       CAPTURE_DURATION_SECONDS=<positive-integer> \
       [SAMPLE_INTERVAL_SECONDS=<positive-integer>] \
       [ALLOW_DIRTY_WORKTREE=0|1] \
       ./scripts/capture-hpa-experiment.sh <new-output-directory>

The EVIDENCE_LOCUST_* values are metadata labels only. This script never starts,
configures, or stops Locust and never mutates Kubernetes resources. Acceptance
captures require a clean Git worktree. ALLOW_DIRTY_WORKTREE=1 is only for local
development smoke tests and is recorded in metadata.json.
EOF
}

trap on_exit EXIT
trap 'on_interrupt INT' INT
trap 'on_interrupt TERM' TERM

if (( $# != 1 )); then
  usage
  die "exactly one new output directory is required"
fi

[[ -n "$output_dir" ]] || die "output directory must not be empty"
[[ "$output_dir" != "/" && "$output_dir" != "." && "$output_dir" != ".." ]] || \
  die "output directory must name a new experiment directory"
[[ ! "$output_dir" =~ [[:cntrl:]] ]] || \
  die "output directory must not contain control characters"
[[ ! -e "$output_dir" && ! -L "$output_dir" ]] || \
  die "output directory already exists; never reuse an experiment directory"

output_parent="$(dirname -- "$output_dir")"
[[ -d "$output_parent" ]] || die "output parent directory does not exist: $output_parent"
[[ -w "$output_parent" ]] || die "output parent directory is not writable: $output_parent"

is_valid_identifier "$experiment_id" || \
  die "EXPERIMENT_ID must be 1-128 letters, digits, dots, underscores, or hyphens and start with a letter or digit"
is_positive_integer "$duration" || \
  die "CAPTURE_DURATION_SECONDS must be a positive integer"
is_positive_integer "$interval" || \
  die "SAMPLE_INTERVAL_SECONDS must be a positive integer"
is_non_negative_integer "$evidence_locust_users" || \
  die "EVIDENCE_LOCUST_USERS must be a non-negative integer"
is_non_negative_integer "$evidence_locust_spawn_rate" || \
  die "EVIDENCE_LOCUST_SPAWN_RATE must be a non-negative integer"
is_non_negative_integer "$evidence_locust_run_seconds" || \
  die "EVIDENCE_LOCUST_RUN_SECONDS must be a non-negative integer"
[[ "$allow_dirty_worktree" == "0" || "$allow_dirty_worktree" == "1" ]] || \
  die "ALLOW_DIRTY_WORKTREE must be 0 or 1"

for required_command in awk chmod cp date git jq mktemp mv rm rmdir sha256sum \
  sleep timeout kubectl; do
  command -v "$required_command" >/dev/null 2>&1 || \
    die "required command is not available: $required_command"
done

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if ! git_revision="$(git -C "$repository_root" rev-parse HEAD 2>/dev/null)"; then
  die "could not determine the repository revision"
fi
if ! git_status="$(git -C "$repository_root" status --porcelain \
  --untracked-files=normal 2>/dev/null)"; then
  die "could not determine whether the Git worktree is clean"
fi
git_dirty=false
[[ -z "$git_status" ]] || git_dirty=true
if [[ "$git_dirty" == "true" && "$allow_dirty_worktree" != "1" ]]; then
  die "acceptance captures require a clean Git worktree; ALLOW_DIRTY_WORKTREE=1 is for development smoke tests only"
fi
dirty_worktree_override=false
[[ "$allow_dirty_worktree" != "1" ]] || dirty_worktree_override=true

work_dir="$(mktemp -d /tmp/autoscaling-hpa-capture.XXXXXX)" || \
  die "could not create a private temporary directory"
chmod 700 "$work_dir" || die "could not protect the temporary directory"

simulator_deployment_start="$work_dir/simulator-deployment-starting.json"
simulator_service_start="$work_dir/simulator-service-starting.json"
hpa_start="$work_dir/hpa-starting.json"
all_hpas_start="$work_dir/all-hpas-starting.json"
simulator_pods_start="$work_dir/simulator-pods-starting.json"
simulator_endpoints_start="$work_dir/simulator-endpointslices-starting.json"
locust_deployment_start="$work_dir/locust-deployment-starting.json"
locust_pods_start="$work_dir/locust-pods-starting.json"

if ! run_kubectl get deployment "$simulator_deployment" \
  --namespace "$simulator_namespace" --output json \
  > "$simulator_deployment_start" 2> "$work_dir/preflight-simulator-deployment.err"; then
  die "read-only preflight could not read the simulator Deployment"
fi
if ! run_kubectl get service "$simulator_service" \
  --namespace "$simulator_namespace" --output json \
  > "$simulator_service_start" 2> "$work_dir/preflight-simulator-service.err"; then
  die "read-only preflight could not read the simulator Service"
fi
if ! run_kubectl get horizontalpodautoscaler "$simulator_hpa" \
  --namespace "$simulator_namespace" --output json \
  > "$hpa_start" 2> "$work_dir/preflight-hpa.err"; then
  die "read-only preflight could not read the simulator HPA"
fi
if ! run_kubectl get horizontalpodautoscalers.autoscaling --all-namespaces \
  --output json > "$all_hpas_start" 2> "$work_dir/preflight-all-hpas.err"; then
  die "read-only preflight could not check all HPA targets"
fi
if ! run_kubectl get pods --namespace "$simulator_namespace" \
  --selector "$simulator_selector" --output json \
  > "$simulator_pods_start" 2> "$work_dir/preflight-simulator-pods.err"; then
  die "read-only preflight could not read simulator Pods"
fi
if ! run_kubectl get endpointslices.discovery.k8s.io \
  --namespace "$simulator_namespace" \
  --selector "kubernetes.io/service-name=$simulator_service" --output json \
  > "$simulator_endpoints_start" 2> "$work_dir/preflight-endpointslices.err"; then
  die "read-only preflight could not read simulator EndpointSlices"
fi
if ! run_kubectl get deployment "$locust_deployment" \
  --namespace "$locust_namespace" --output json \
  > "$locust_deployment_start" 2> "$work_dir/preflight-locust-deployment.err"; then
  die "read-only preflight could not read the Locust Deployment"
fi
if ! run_kubectl get pods --namespace "$locust_namespace" \
  --selector "$locust_selector" --output json \
  > "$locust_pods_start" 2> "$work_dir/preflight-locust-pods.err"; then
  die "read-only preflight could not read Locust Pods"
fi

hpa_configuration_is_valid "$hpa_start" || \
  die "the simulator HPA must target apps/v1 Deployment/metronome-simulator with one CPU utilization metric at 70%, minReplicas 1, and maxReplicas 6"
no_hpa_targets_locust "$all_hpas_start" || \
  die "Locust must not be targeted by an HPA"
deployment_is_settled_at_one "$simulator_deployment_start" "$simulator_container" || \
  die "simulator Deployment must be fully observed and settled at one desired, current, updated, Ready, and available replica"
single_pod_is_settled "$simulator_pods_start" "$simulator_container" || \
  die "simulator must initially have exactly one non-terminating, Running, Ready Pod with resolved runtime identity"
no_terminating_pods "$simulator_pods_start" || \
  die "simulator must not have terminating Pods at preflight"
deployment_is_settled_at_one "$locust_deployment_start" "$locust_container" || \
  die "Locust Deployment must be fully observed and settled at one replica"
single_pod_is_settled "$locust_pods_start" "$locust_container" || \
  die "Locust must have exactly one non-terminating, Running, Ready Pod with resolved runtime identity"

if ! run_kubectl top pods --namespace "$simulator_namespace" \
  --selector "$simulator_selector" --containers --no-headers \
  > "$work_dir/preflight-simulator-top.txt" 2> "$work_dir/preflight-simulator-top.err"; then
  die "Metrics API preflight failed for simulator Pods"
fi
if ! awk -v container="$simulator_container" \
  '$2 == container {found=1} END {exit !found}' \
  "$work_dir/preflight-simulator-top.txt"; then
  die "Metrics API has no sample for the simulator container"
fi
if ! run_kubectl top pods --namespace "$locust_namespace" \
  --selector "$locust_selector" --containers --no-headers \
  > "$work_dir/preflight-locust-top.txt" 2> "$work_dir/preflight-locust-top.err"; then
  die "Metrics API preflight failed for the Locust Pod"
fi
if ! awk -v container="$locust_container" \
  '$2 == container {found=1} END {exit !found}' \
  "$work_dir/preflight-locust-top.txt"; then
  die "Metrics API has no sample for the Locust container"
fi

simulator_deployment_fingerprint="$(
  simulator_deployment_fingerprint_for "$simulator_deployment_start"
)" || die "could not fingerprint the simulator Deployment"
simulator_service_fingerprint="$(
  object_spec_fingerprint_for "$simulator_service_start"
)" || die "could not fingerprint the simulator Service"
hpa_fingerprint="$(object_spec_fingerprint_for "$hpa_start")" || \
  die "could not fingerprint the simulator HPA"
locust_deployment_fingerprint="$(
  object_spec_fingerprint_for "$locust_deployment_start"
)" || die "could not fingerprint the Locust Deployment"
simulator_runtime_image_id="$(
  runtime_image_id_for_single_pod "$simulator_pods_start" "$simulator_container"
)" || die "could not fingerprint the simulator runtime image"
simulator_runtime_image="$(
  runtime_image_for_single_pod "$simulator_pods_start" "$simulator_container"
)" || die "could not record the simulator runtime image"
locust_runtime_identity="$(
  runtime_identity_for_single_pod "$locust_pods_start" "$locust_container"
)" || die "could not fingerprint the Locust Pod runtime"

# Atomically reserve the evidence path only after all input and cluster checks.
if ! mkdir -m 0700 -- "$output_dir"; then
  die "could not create the new output directory (it may now exist)"
fi
capture_started=1
if ! capture_start_timestamp="$(date --utc --iso-8601=seconds)"; then
  die "could not record the capture start time"
fi

for snapshot in \
  "$simulator_deployment_start:starting-simulator-deployment.json" \
  "$simulator_service_start:starting-simulator-service.json" \
  "$hpa_start:starting-hpa.json" \
  "$simulator_pods_start:starting-simulator-pods.json" \
  "$simulator_endpoints_start:starting-endpointslices.json" \
  "$locust_deployment_start:starting-locust-deployment.json" \
  "$locust_pods_start:starting-locust-pods.json"; do
  source_file="${snapshot%%:*}"
  destination_name="${snapshot#*:}"
  install_snapshot "$source_file" "$output_dir/$destination_name" || \
    die "could not publish starting snapshot: $destination_name"
done

metadata_tmp="$work_dir/metadata.json"
if ! jq -n \
  --slurpfile simulator_deployment "$simulator_deployment_start" \
  --slurpfile simulator_service "$simulator_service_start" \
  --slurpfile hpa "$hpa_start" \
  --slurpfile simulator_pods "$simulator_pods_start" \
  --slurpfile locust_deployment "$locust_deployment_start" \
  --slurpfile locust_pods "$locust_pods_start" \
  --arg schema_version "1" \
  --arg experiment_id "$experiment_id" \
  --arg started_at "$capture_start_timestamp" \
  --arg git_revision "$git_revision" \
  --argjson git_dirty "$git_dirty" \
  --argjson dirty_allowed "$dirty_worktree_override" \
  --argjson duration_seconds "$duration" \
  --argjson sample_interval_seconds "$interval" \
  --argjson locust_users "$evidence_locust_users" \
  --argjson locust_spawn_rate "$evidence_locust_spawn_rate" \
  --argjson locust_run_seconds "$evidence_locust_run_seconds" \
  --arg simulator_container "$simulator_container" \
  --arg locust_container "$locust_container" \
  --arg simulator_deployment_fingerprint "$simulator_deployment_fingerprint" \
  --arg simulator_service_fingerprint "$simulator_service_fingerprint" \
  --arg hpa_fingerprint "$hpa_fingerprint" \
  --arg locust_deployment_fingerprint "$locust_deployment_fingerprint" \
  --arg simulator_runtime_image "$simulator_runtime_image" \
  --arg simulator_runtime_image_id "$simulator_runtime_image_id" '
  {
    schemaVersion: $schema_version,
    experimentId: $experiment_id,
    captureStartedAt: $started_at,
    inputs: {
      captureDurationSeconds: $duration_seconds,
      sampleIntervalSeconds: $sample_interval_seconds,
      evidenceLocustUsers: $locust_users,
      evidenceLocustSpawnRate: $locust_spawn_rate,
      evidenceLocustRunSeconds: $locust_run_seconds,
      locustValuesAreMetadataOnly: true,
      allowDirtyWorktree: $dirty_allowed
    },
    source: {
      gitRevision: $git_revision,
      worktreeDirty: $git_dirty,
      dirtyWorktreeOverride: $dirty_allowed
    },
    fingerprints: {
      simulatorDeploymentStableIdentitySpecSha256: $simulator_deployment_fingerprint,
      simulatorDeploymentExcludedDynamicFields: ["spec.replicas", "metadata.generation"],
      simulatorServiceIdentitySpecSha256: $simulator_service_fingerprint,
      simulatorHpaIdentitySpecSha256: $hpa_fingerprint,
      simulatorRuntimeImage: $simulator_runtime_image,
      simulatorRuntimeImageId: $simulator_runtime_image_id,
      locustDeploymentIdentitySpecSha256: $locust_deployment_fingerprint,
      locustRuntimeIdentity: ($locust_pods[0].items[0] |
        (.status.containerStatuses[] | select(.name == $locust_container)) as $status |
        {
          podUid: .metadata.uid,
          containerId: $status.containerID,
          restartCount: $status.restartCount,
          runtimeImage: $status.image,
          runtimeImageId: $status.imageID
        })
    },
    simulator: {
      namespace: $simulator_deployment[0].metadata.namespace,
      deployment: {
        name: $simulator_deployment[0].metadata.name,
        uid: $simulator_deployment[0].metadata.uid,
        stableIdentitySpecSha256: $simulator_deployment_fingerprint,
        resourceSettings: ($simulator_deployment[0].spec.template.spec.containers[] |
          select(.name == $simulator_container) | .resources),
        declaredImage: ($simulator_deployment[0].spec.template.spec.containers[] |
          select(.name == $simulator_container) | .image)
      },
      service: {
        name: $simulator_service[0].metadata.name,
        uid: $simulator_service[0].metadata.uid,
        identitySpecSha256: $simulator_service_fingerprint,
        spec: $simulator_service[0].spec
      },
      hpa: {
        name: $hpa[0].metadata.name,
        uid: $hpa[0].metadata.uid,
        identitySpecSha256: $hpa_fingerprint,
        startingConfiguration: $hpa[0].spec
      },
      startingPod: ($simulator_pods[0].items[0] |
        (.status.containerStatuses[] | select(.name == $simulator_container)) as $status |
        {
          name: .metadata.name,
          uid: .metadata.uid,
          node: .spec.nodeName,
          containerId: $status.containerID,
          runtimeImage: $status.image,
          runtimeImageId: $simulator_runtime_image_id,
          restartCount: $status.restartCount
        })
    },
    locust: {
      namespace: $locust_deployment[0].metadata.namespace,
      deployment: {
        name: $locust_deployment[0].metadata.name,
        uid: $locust_deployment[0].metadata.uid,
        identitySpecSha256: $locust_deployment_fingerprint,
        resourceSettings: ($locust_deployment[0].spec.template.spec.containers[] |
          select(.name == $locust_container) | .resources),
        declaredImage: ($locust_deployment[0].spec.template.spec.containers[] |
          select(.name == $locust_container) | .image)
      },
      runtime: ($locust_pods[0].items[0] |
        (.status.containerStatuses[] | select(.name == $locust_container)) as $status |
        {
          podName: .metadata.name,
          podUid: .metadata.uid,
          containerId: $status.containerID,
          runtimeImage: $status.image,
          runtimeImageId: $status.imageID,
          restartCount: $status.restartCount
        }),
      uiLabels: {
        users: $locust_users,
        spawnRate: $locust_spawn_rate,
        runSeconds: $locust_run_seconds,
        metadataOnly: true
      }
    }
  }' > "$metadata_tmp"; then
  die "could not create experiment metadata"
fi
mv -- "$metadata_tmp" "$output_dir/metadata.json" || \
  die "could not publish experiment metadata"

hpa_file="$output_dir/hpa.csv"
replica_file="$output_dir/replicas.csv"
pod_file="$output_dir/pods.csv"
endpoint_file="$output_dir/endpoints.csv"
sample_status_file="$output_dir/sample-status.csv"

printf 'timestamp,current_cpu_utilization,current_cpu_average_value,target_cpu_utilization,current_replicas,desired_replicas,condition_reasons\n' > "$hpa_file" || die "could not initialize hpa.csv"
printf 'timestamp,desired_replicas,current_replicas,updated_replicas,available_replicas,ready_replicas,unavailable_replicas\n' > "$replica_file" || die "could not initialize replicas.csv"
printf 'timestamp,pod_name,pod_uid,node,phase,deletion_timestamp,terminating,pod_ready,container_ready,restart_count,declared_image,runtime_image,runtime_image_id,container_id,cpu,memory\n' > "$pod_file" || die "could not initialize pods.csv"
printf 'timestamp,endpointslice_name,address,target_pod,ready,serving,terminating\n' > "$endpoint_file" || die "could not initialize endpoints.csv"
printf 'scheduled_at,sample_started_at,sample_completed_at,sample_number,status,hpa,deployment,pods,pod_metrics,endpointslices\n' > "$sample_status_file" || die "could not initialize sample-status.csv"

printf 'Capturing %s for %s seconds every %s seconds.\n' \
  "$experiment_id" "$duration" "$interval"
printf 'Locust values are metadata only; configure and stop the run manually.\n'

start_epoch="$(date +%s)"
end_epoch=$(( start_epoch + duration ))
next_deadline_epoch="$start_epoch"
while (( next_deadline_epoch < end_epoch )); do
  now_epoch="$(date +%s)"
  if (( now_epoch < next_deadline_epoch )); then
    sleep "$(( next_deadline_epoch - now_epoch ))"
  fi

  scheduled_at="$(date --utc --iso-8601=seconds \
    --date="@${next_deadline_epoch}")"
  sample_started_at="$(date --utc --iso-8601=seconds)"
  (( sample_count += 1 ))

  capture_hpa
  capture_deployment
  capture_pods
  capture_endpoints

  sample_completed_at="$(date --utc --iso-8601=seconds)"
  sample_status="ok"
  if [[ "$hpa_sample_status" != "ok" ||
        "$deployment_sample_status" != "ok" ||
        "$pods_sample_status" != "ok" ||
        "$pod_metrics_sample_status" != "ok" ||
        "$endpoints_sample_status" != "ok" ]]; then
    sample_status="failed"
    (( failed_sample_count += 1 ))
  else
    (( successful_sample_count += 1 ))
  fi

  if ! printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$scheduled_at" "$sample_started_at" "$sample_completed_at" \
    "$sample_count" "$sample_status" "$hpa_sample_status" \
    "$deployment_sample_status" "$pods_sample_status" \
    "$pod_metrics_sample_status" "$endpoints_sample_status" \
    >> "$sample_status_file"; then
    printf 'error: could not record sample status\n' >&2
    exit 1
  fi

  next_deadline_epoch=$(( next_deadline_epoch + interval ))
  now_epoch="$(date +%s)"
  while (( next_deadline_epoch < now_epoch )); do
    next_deadline_epoch=$(( next_deadline_epoch + interval ))
  done
done

now_epoch="$(date +%s)"
if (( now_epoch < end_epoch )); then
  sleep "$(( end_epoch - now_epoch ))"
fi

final_collection_exit=0
collect_final_artifacts || final_collection_exit=$?
final_validation_exit=0
if (( final_collection_exit == 0 )); then
  validate_final_state || final_validation_exit=$?
else
  final_validation_status="not-run-final-artifact-collection-failed"
fi

if (( sample_count == 0 )); then
  printf 'error: capture ended without any samples\n' >&2
  exit 1
fi
if (( final_collection_exit != 0 )); then
  printf 'error: final artifact collection failed\n' >&2
  exit 1
fi
if (( final_validation_exit != 0 )); then
  printf 'error: final workload validation failed: %s\n' \
    "$final_validation_status" >&2
  exit 1
fi
if (( failed_sample_count > 0 )); then
  printf 'error: %d of %d samples had required-data failures\n' \
    "$failed_sample_count" "$sample_count" >&2
  exit 1
fi

exit 0
