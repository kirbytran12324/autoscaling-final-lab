#!/usr/bin/env bash

set -uo pipefail
umask 077

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

die() {
  printf 'error: %s\n' "$1" >&2
  exit 2
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

is_non_negative_integer() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)$ ]]
}

is_valid_identifier() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]
}

run_kubectl() {
  case "${1:-}" in
    get|logs|top) ;;
    *)
      printf 'error: internal refusal of non-read-only kubectl command: %s\n' \
        "${1:-<empty>}" >&2
      return 64
      ;;
  esac

  timeout "${kubectl_timeout_seconds}s" \
    kubectl --request-timeout="${kubectl_timeout_seconds}s" "$@"
}

deployment_is_settled_at_one() {
  local deployment_file="$1"
  local container="$2"

  jq -e --arg container "$container" '
    .metadata.uid != null and
    .metadata.generation == .status.observedGeneration and
    .spec.replicas == 1 and
    .status.replicas == 1 and
    .status.updatedReplicas == 1 and
    .status.readyReplicas == 1 and
    .status.availableReplicas == 1 and
    (.status.unavailableReplicas // 0) == 0 and
    any(.spec.template.spec.containers[]; .name == $container)
  ' "$deployment_file" >/dev/null
}

single_pod_is_settled() {
  local pods_file="$1"
  local container="$2"

  jq -e --arg container "$container" '
    (.items | length) == 1 and
    .items[0].metadata.deletionTimestamp == null and
    (.items[0].metadata.ownerReferences // [] | any(.kind == "ReplicaSet")) and
    .items[0].status.phase == "Running" and
    (.items[0].status.conditions // [] |
      any(.type == "Ready" and .status == "True")) and
    (.items[0].status.containerStatuses // [] |
      any(.name == $container and .ready == true and
          (.imageID // "") != "" and (.containerID // "") != ""))
  ' "$pods_file" >/dev/null
}

no_terminating_pods() {
  jq -e 'all(.items[]; .metadata.deletionTimestamp == null)' "$1" >/dev/null
}

hpa_configuration_is_valid() {
  jq -e \
    --arg namespace "$simulator_namespace" \
    --arg name "$simulator_hpa" \
    --arg deployment "$simulator_deployment" '
    .metadata.namespace == $namespace and
    .metadata.name == $name and
    .metadata.uid != null and
    .spec.scaleTargetRef.apiVersion == "apps/v1" and
    .spec.scaleTargetRef.kind == "Deployment" and
    .spec.scaleTargetRef.name == $deployment and
    .spec.minReplicas == 1 and
    .spec.maxReplicas == 6 and
    (.spec.metrics | length) == 1 and
    .spec.metrics[0].type == "Resource" and
    .spec.metrics[0].resource.name == "cpu" and
    .spec.metrics[0].resource.target.type == "Utilization" and
    .spec.metrics[0].resource.target.averageUtilization == 70
  ' "$1" >/dev/null
}

no_hpa_targets_locust() {
  jq -e \
    --arg namespace "$locust_namespace" \
    --arg deployment "$locust_deployment" '
    [.items[] | select(
      .metadata.namespace == $namespace and
      .spec.scaleTargetRef.kind == "Deployment" and
      .spec.scaleTargetRef.name == $deployment
    )] | length == 0
  ' "$1" >/dev/null
}

simulator_deployment_fingerprint_for() {
  jq -cS '{uid: .metadata.uid, spec: (.spec | del(.replicas))}' "$1" |
    sha256sum | awk '{print $1}'
}

object_spec_fingerprint_for() {
  jq -cS '{uid: .metadata.uid, spec: .spec}' "$1" |
    sha256sum | awk '{print $1}'
}

runtime_image_id_for_single_pod() {
  local pods_file="$1"
  local container="$2"

  jq -er --arg container "$container" '
    .items[0].status.containerStatuses[] |
    select(.name == $container) | .imageID
  ' "$pods_file"
}

runtime_image_for_single_pod() {
  local pods_file="$1"
  local container="$2"

  jq -er --arg container "$container" '
    .items[0].status.containerStatuses[] |
    select(.name == $container) | .image
  ' "$pods_file"
}

runtime_identity_for_single_pod() {
  local pods_file="$1"
  local container="$2"

  jq -cerS --arg container "$container" '
    .items[0] as $pod |
    ($pod.status.containerStatuses[] | select(.name == $container)) as $status |
    {
      podUid: $pod.metadata.uid,
      containerId: $status.containerID,
      restartCount: $status.restartCount,
      runtimeImage: $status.image,
      imageId: $status.imageID
    }
  ' "$pods_file"
}

all_runtime_images_match() {
  local pods_file="$1"
  local container="$2"
  local expected_image="$3"
  local expected_image_id="$4"

  jq -e --arg container "$container" --arg expected_image "$expected_image" \
    --arg expected_image_id "$expected_image_id" '
    (.items | length) > 0 and
    ([.items[].status.containerStatuses[]? |
      select(.name == $container and (.imageID // "") != "")] | length) > 0 and
    all(.items[].status.containerStatuses[]?;
      if .name != $container or (.imageID // "") == "" then true
      else .image == $expected_image and .imageID == $expected_image_id
      end)
  ' "$pods_file" >/dev/null
}

install_snapshot() {
  local source_file="$1"
  local destination="$2"

  command cp -- "$source_file" "$destination"
  chmod 600 "$destination"
}

# These functions are reached through signal and EXIT traps.
# shellcheck disable=SC2329
cleanup_work_dir() {
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    rm -f -- "$work_dir"/*
    rmdir -- "$work_dir" 2>/dev/null || true
  fi
}

# shellcheck disable=SC2329
derive_observations() {
  max_desired_replicas=0
  max_ready_replicas=0
  final_desired_replicas=0
  final_ready_replicas=0

  if [[ -f "$output_dir/hpa.csv" ]]; then
    max_desired_replicas="$(awk -F, '
      NR > 1 {gsub(/"/, "", $6); if (($6 + 0) > max) max=$6 + 0}
      END {print max + 0}' "$output_dir/hpa.csv")"
  fi
  if [[ -f "$output_dir/replicas.csv" ]]; then
    max_ready_replicas="$(awk -F, '
      NR > 1 {gsub(/"/, "", $6); if (($6 + 0) > max) max=$6 + 0}
      END {print max + 0}' "$output_dir/replicas.csv")"
  fi
  if [[ -f "$work_dir/simulator-deployment-ending.json" ]]; then
    final_desired_replicas="$(jq -r '.spec.replicas // 0' \
      "$work_dir/simulator-deployment-ending.json")"
    final_ready_replicas="$(jq -r '.status.readyReplicas // 0' \
      "$work_dir/simulator-deployment-ending.json")"
  fi
}

# shellcheck disable=SC2329
write_capture_status() {
  local exit_code="$1"
  local capture_status="failed"
  local end_timestamp status_tmp

  (( capture_started == 1 )) || return 0
  (( capture_finished == 0 )) || return 0

  derive_observations
  end_timestamp="$(date --utc --iso-8601=seconds)"
  if [[ -n "$signal_name" ]]; then
    capture_status="interrupted"
  elif (( exit_code == 0 && failed_sample_count == 0 )) &&
       [[ "$final_validation_status" == "ok" &&
          "$final_collection_status" == "ok" ]]; then
    capture_status="complete"
  fi

  status_tmp="$work_dir/capture-status.json"
  if ! jq -n \
    --arg schema_version "1" \
    --arg experiment_id "$experiment_id" \
    --arg status "$capture_status" \
    --arg started_at "$capture_start_timestamp" \
    --arg ended_at "$end_timestamp" \
    --arg signal "$signal_name" \
    --arg final_validation "$final_validation_status" \
    --arg final_collection "$final_collection_status" \
    --argjson exit_code "$exit_code" \
    --argjson samples "$sample_count" \
    --argjson successful_samples "$successful_sample_count" \
    --argjson failed_samples "$failed_sample_count" \
    --argjson max_desired "$max_desired_replicas" \
    --argjson max_ready "$max_ready_replicas" \
    --argjson final_desired "$final_desired_replicas" \
    --argjson final_ready "$final_ready_replicas" '
    {
      schemaVersion: $schema_version,
      experimentId: $experiment_id,
      status: $status,
      startedAt: $started_at,
      endedAt: $ended_at,
      exitCode: $exit_code,
      sampleCount: $samples,
      successfulSampleCount: $successful_samples,
      failedSampleCount: $failed_samples,
      finalValidation: $final_validation,
      finalArtifactCollection: $final_collection,
      interruptionSignal: (if $signal == "" then null else $signal end),
      observations: {
        maximumDesiredReplicas: $max_desired,
        maximumReadyReplicas: $max_ready,
        finalReplicaCount: $final_ready,
        finalDesiredReplicas: $final_desired,
        experimentAcceptanceEvaluated: false,
        note: "Collection completion does not establish experiment acceptance. Evaluate scaling and service results separately."
      }
    }' > "$status_tmp"; then
    printf 'error: could not create capture status\n' >&2
    return 1
  fi

  if ! mv -- "$status_tmp" "$output_dir/capture-status.json"; then
    printf 'error: could not publish capture status\n' >&2
    return 1
  fi
  capture_finished=1
}

# shellcheck disable=SC2329
on_exit() {
  local exit_code="$?"

  trap - EXIT
  if ! write_capture_status "$exit_code"; then
    exit_code=1
  fi
  cleanup_work_dir

  if (( capture_started == 1 )); then
    if (( exit_code == 0 )); then
      printf 'Capture collection completed: %s\n' "$output_dir"
    else
      printf 'Capture did not complete successfully (exit %d): %s\n' \
        "$exit_code" "$output_dir" >&2
    fi
  fi
  exit "$exit_code"
}

# shellcheck disable=SC2329
on_interrupt() {
  signal_name="$1"
  if [[ "$signal_name" == "INT" ]]; then
    exit 130
  fi
  exit 143
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

capture_hpa() {
  local raw="$work_dir/hpa-sample.json"
  local parsed="$work_dir/hpa-sample.csv"
  local timestamp

  hpa_sample_status="failed"
  if ! run_kubectl get horizontalpodautoscaler "$simulator_hpa" \
    --namespace "$simulator_namespace" --output json \
    > "$raw" 2> "$work_dir/hpa-sample.err"; then
    return
  fi
  timestamp="$(date --utc --iso-8601=seconds)"
  if ! jq -er --arg timestamp "$timestamp" '
    (.status.currentMetrics // [] | map(select(
      .type == "Resource" and .resource.name == "cpu")) | first |
      .resource.current // {}) as $current |
    (.spec.metrics | map(select(
      .type == "Resource" and .resource.name == "cpu")) | first |
      .resource.target) as $target |
    [$timestamp,
     ($current.averageUtilization // ""),
     ($current.averageValue // ""),
     ($target.averageUtilization // ""),
     (.status.currentReplicas // 0),
     (.status.desiredReplicas // 0),
     ([.status.conditions[]? |
       (.type + "=" + .status + ":" + (.reason // ""))] | join(";"))]
    | @csv
  ' "$raw" > "$parsed"; then
    hpa_sample_status="parse-failed"
    return
  fi
  if ! command awk 'NF' "$parsed" >> "$hpa_file"; then
    hpa_sample_status="write-failed"
    return
  fi
  hpa_sample_status="ok"
}

capture_deployment() {
  local raw="$work_dir/deployment-sample.json"
  local parsed="$work_dir/deployment-sample.csv"
  local timestamp

  deployment_sample_status="failed"
  if ! run_kubectl get deployment "$simulator_deployment" \
    --namespace "$simulator_namespace" --output json \
    > "$raw" 2> "$work_dir/deployment-sample.err"; then
    return
  fi
  timestamp="$(date --utc --iso-8601=seconds)"
  if ! jq -er --arg timestamp "$timestamp" '
    [$timestamp, (.spec.replicas // 0), (.status.replicas // 0),
     (.status.updatedReplicas // 0), (.status.availableReplicas // 0),
     (.status.readyReplicas // 0), (.status.unavailableReplicas // 0)] | @csv
  ' "$raw" > "$parsed"; then
    deployment_sample_status="parse-failed"
    return
  fi
  if ! command awk 'NF' "$parsed" >> "$replica_file"; then
    deployment_sample_status="write-failed"
    return
  fi
  deployment_sample_status="ok"
}

capture_pods() {
  local pods_raw="$work_dir/pods-sample.json"
  local metrics_raw="$work_dir/pod-metrics-sample.txt"
  local pod_rows="$work_dir/pod-rows-sample.tsv"
  local parsed="$work_dir/pods-sample.csv"
  local timestamp pod_name pod_uid node phase deletion_timestamp terminating
  local pod_ready container_ready restart_count declared_image runtime_image
  local runtime_image_id container_id cpu memory

  pods_sample_status="failed"
  pod_metrics_sample_status="failed"
  if run_kubectl get pods --namespace "$simulator_namespace" \
    --selector "$simulator_selector" --output json \
    > "$pods_raw" 2> "$work_dir/pods-sample.err"; then
    pods_sample_status="ok"
  fi
  if run_kubectl top pods --namespace "$simulator_namespace" \
    --selector "$simulator_selector" --containers --no-headers \
    > "$metrics_raw" 2> "$work_dir/pod-metrics-sample.err"; then
    pod_metrics_sample_status="ok"
  fi
  [[ "$pods_sample_status" == "ok" ]] || return

  timestamp="$(date --utc --iso-8601=seconds)"
  if ! jq -er --arg container "$simulator_container" '
    if (.items | length) == 0 then error("no simulator Pods") else . end |
    .items[] |
    (.status.containerStatuses // [] | map(select(.name == $container)) | first // {}) as $status |
    (.spec.containers // [] | map(select(.name == $container)) | first // {}) as $container_spec |
    (.status.conditions // [] | map(select(.type == "Ready")) | first // {}) as $ready |
    [.metadata.name, .metadata.uid, (.spec.nodeName // ""),
     (.status.phase // "Unknown"), (.metadata.deletionTimestamp // ""),
     (.metadata.deletionTimestamp != null), ($ready.status // "Unknown"),
     ($status.ready // false), ($status.restartCount // 0),
     ($container_spec.image // ""), ($status.image // ""),
     ($status.imageID // ""), ($status.containerID // "")] | join("\u001f")
  ' "$pods_raw" > "$pod_rows"; then
    pods_sample_status="parse-failed"
    return
  fi

  : > "$parsed"
  while IFS=$'\x1f' read -r pod_name pod_uid node phase deletion_timestamp \
    terminating pod_ready container_ready restart_count declared_image \
    runtime_image runtime_image_id container_id; do
    cpu=""
    memory=""
    if [[ "$pod_metrics_sample_status" == "ok" ]]; then
      read -r cpu memory < <(awk -v pod="$pod_name" \
        -v container="$simulator_container" \
        '$1 == pod && $2 == container {print $3, $4; exit}' "$metrics_raw")
    fi
    jq -nr --arg timestamp "$timestamp" --arg pod_name "$pod_name" \
      --arg pod_uid "$pod_uid" --arg node "$node" --arg phase "$phase" \
      --arg deletion_timestamp "$deletion_timestamp" \
      --arg terminating "$terminating" --arg pod_ready "$pod_ready" \
      --arg container_ready "$container_ready" --arg restart_count "$restart_count" \
      --arg declared_image "$declared_image" --arg runtime_image "$runtime_image" \
      --arg runtime_image_id "$runtime_image_id" --arg container_id "$container_id" \
      --arg cpu "$cpu" --arg memory "$memory" \
      '[$timestamp, $pod_name, $pod_uid, $node, $phase, $deletion_timestamp,
        $terminating, $pod_ready, $container_ready, $restart_count,
        $declared_image, $runtime_image, $runtime_image_id, $container_id,
        $cpu, $memory] | @csv' >> "$parsed" || {
          pods_sample_status="parse-failed"
          return
        }
  done < "$pod_rows"

  if ! command awk 'NF' "$parsed" >> "$pod_file"; then
    pods_sample_status="write-failed"
  fi
}

capture_endpoints() {
  local raw="$work_dir/endpoints-sample.json"
  local parsed="$work_dir/endpoints-sample.csv"
  local timestamp

  endpoints_sample_status="failed"
  if ! run_kubectl get endpointslices.discovery.k8s.io \
    --namespace "$simulator_namespace" \
    --selector "kubernetes.io/service-name=$simulator_service" --output json \
    > "$raw" 2> "$work_dir/endpoints-sample.err"; then
    return
  fi
  timestamp="$(date --utc --iso-8601=seconds)"
  if ! jq -er --arg timestamp "$timestamp" '
    .items[] as $slice |
    $slice.endpoints[]? as $endpoint |
    $endpoint.addresses[]? |
    [$timestamp, $slice.metadata.name, ., ($endpoint.targetRef.name // ""),
     ($endpoint.conditions.ready // ""),
     ($endpoint.conditions.serving // ""),
     ($endpoint.conditions.terminating // "")] | @csv
  ' "$raw" > "$parsed"; then
    endpoints_sample_status="parse-failed"
    return
  fi
  if ! command awk 'NF' "$parsed" >> "$endpoint_file"; then
    endpoints_sample_status="write-failed"
    return
  fi
  endpoints_sample_status="ok"
}

collect_final_artifacts() {
  local locust_pod_name summary_line

  final_collection_status="failed"
  run_kubectl get deployment "$simulator_deployment" \
    --namespace "$simulator_namespace" --output json \
    > "$work_dir/simulator-deployment-ending.json" \
    2> "$work_dir/final-simulator-deployment.err" || return 1
  run_kubectl get service "$simulator_service" \
    --namespace "$simulator_namespace" --output json \
    > "$work_dir/simulator-service-ending.json" \
    2> "$work_dir/final-simulator-service.err" || return 1
  run_kubectl get horizontalpodautoscaler "$simulator_hpa" \
    --namespace "$simulator_namespace" --output json \
    > "$work_dir/hpa-ending.json" 2> "$work_dir/final-hpa.err" || return 1
  run_kubectl get horizontalpodautoscalers.autoscaling --all-namespaces \
    --output json > "$work_dir/all-hpas-ending.json" \
    2> "$work_dir/final-all-hpas.err" || return 1
  run_kubectl get pods --namespace "$simulator_namespace" \
    --selector "$simulator_selector" --output json \
    > "$work_dir/simulator-pods-ending.json" \
    2> "$work_dir/final-simulator-pods.err" || return 1
  run_kubectl get endpointslices.discovery.k8s.io \
    --namespace "$simulator_namespace" \
    --selector "kubernetes.io/service-name=$simulator_service" --output json \
    > "$work_dir/simulator-endpointslices-ending.json" \
    2> "$work_dir/final-endpointslices.err" || return 1
  run_kubectl get deployment "$locust_deployment" \
    --namespace "$locust_namespace" --output json \
    > "$work_dir/locust-deployment-ending.json" \
    2> "$work_dir/final-locust-deployment.err" || return 1
  run_kubectl get pods --namespace "$locust_namespace" \
    --selector "$locust_selector" --output json \
    > "$work_dir/locust-pods-ending.json" \
    2> "$work_dir/final-locust-pods.err" || return 1

  run_kubectl get events --namespace "$simulator_namespace" \
    --field-selector "involvedObject.kind=HorizontalPodAutoscaler,involvedObject.name=$simulator_hpa" \
    --output json > "$output_dir/hpa-events.json" \
    2> "$work_dir/final-hpa-events.err" || return 1
  run_kubectl get events --namespace "$simulator_namespace" --output json \
    > "$output_dir/namespace-events.json" \
    2> "$work_dir/final-namespace-events.err" || return 1

  locust_pod_name="$(jq -er '.items[0].metadata.name' \
    "$work_dir/locust-pods-ending.json")" || return 1
  run_kubectl logs --namespace "$locust_namespace" "$locust_pod_name" \
    --container "$locust_container" --since-time "$capture_start_timestamp" \
    --timestamps=true > "$output_dir/locust.log" \
    2> "$work_dir/final-locust-logs.err" || return 1

  summary_line="$(awk '/servedBy distribution:/ {line=$0} END {print line}' \
    "$output_dir/locust.log")"
  if [[ -n "$summary_line" ]]; then
    printf '%s\n' "$summary_line" > "$output_dir/served-by-summary.txt" || return 1
  else
    printf '%s\n' \
      'unavailable: Locust was not stopped before capture completion, so no servedBy distribution line was logged during the capture period.' \
      > "$output_dir/served-by-summary.txt" || return 1
  fi

  for snapshot in \
    "$work_dir/simulator-deployment-ending.json:ending-simulator-deployment.json" \
    "$work_dir/simulator-service-ending.json:ending-simulator-service.json" \
    "$work_dir/hpa-ending.json:ending-hpa.json" \
    "$work_dir/simulator-pods-ending.json:ending-simulator-pods.json" \
    "$work_dir/simulator-endpointslices-ending.json:ending-endpointslices.json" \
    "$work_dir/locust-deployment-ending.json:ending-locust-deployment.json" \
    "$work_dir/locust-pods-ending.json:ending-locust-pods.json"; do
    source_file="${snapshot%%:*}"
    destination_name="${snapshot#*:}"
    install_snapshot "$source_file" "$output_dir/$destination_name" || return 1
  done
  final_collection_status="ok"
}

validate_final_state() {
  local actual_fingerprint actual_runtime_identity

  final_validation_status="simulator-deployment-changed"
  actual_fingerprint="$(simulator_deployment_fingerprint_for \
    "$work_dir/simulator-deployment-ending.json")" || return 1
  [[ "$actual_fingerprint" == "$simulator_deployment_fingerprint" ]] || return 1

  final_validation_status="simulator-service-changed"
  actual_fingerprint="$(object_spec_fingerprint_for \
    "$work_dir/simulator-service-ending.json")" || return 1
  [[ "$actual_fingerprint" == "$simulator_service_fingerprint" ]] || return 1

  final_validation_status="hpa-changed"
  actual_fingerprint="$(object_spec_fingerprint_for \
    "$work_dir/hpa-ending.json")" || return 1
  [[ "$actual_fingerprint" == "$hpa_fingerprint" ]] || return 1

  final_validation_status="simulator-runtime-image-changed-or-unavailable"
  all_runtime_images_match "$work_dir/simulator-pods-ending.json" \
    "$simulator_container" "$simulator_runtime_image" \
    "$simulator_runtime_image_id" || return 1

  final_validation_status="locust-deployment-changed"
  actual_fingerprint="$(object_spec_fingerprint_for \
    "$work_dir/locust-deployment-ending.json")" || return 1
  [[ "$actual_fingerprint" == "$locust_deployment_fingerprint" ]] || return 1

  final_validation_status="locust-runtime-changed"
  single_pod_is_settled "$work_dir/locust-pods-ending.json" \
    "$locust_container" || return 1
  actual_runtime_identity="$(runtime_identity_for_single_pod \
    "$work_dir/locust-pods-ending.json" "$locust_container")" || return 1
  [[ "$actual_runtime_identity" == "$locust_runtime_identity" ]] || return 1

  final_validation_status="locust-became-hpa-target"
  no_hpa_targets_locust "$work_dir/all-hpas-ending.json" || return 1

  final_validation_status="ok"
}

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
