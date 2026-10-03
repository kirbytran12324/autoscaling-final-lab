#!/usr/bin/env bash

set -uo pipefail
umask 077

# shellcheck source=lib/capture-common.sh
source "${BASH_SOURCE[0]%/*}/lib/capture-common.sh"
# shellcheck source=lib/resource-guards.sh
source "${BASH_SOURCE[0]%/*}/lib/resource-guards.sh"
# shellcheck source=lib/resource-status.sh
source "${BASH_SOURCE[0]%/*}/lib/resource-status.sh"
# shellcheck source=lib/resource-sampling.sh
source "${BASH_SOURCE[0]%/*}/lib/resource-sampling.sh"

readonly simulator_namespace="autoscaling-lab"
readonly simulator_deployment="metronome-simulator"
readonly simulator_selector="app=metronome-simulator"
readonly simulator_container="simulator"
readonly locust_namespace="load-testing"
readonly locust_deployment="metronome-load-test"
readonly locust_selector="app=metronome-load-test"
readonly locust_container="locust"
readonly kubectl_timeout_seconds=15

output_dir="${1:-}"
interval="${SAMPLE_INTERVAL_SECONDS:-15}"
duration="${CAPTURE_DURATION_SECONDS:-}"
experiment_id="${EXPERIMENT_ID:-}"
experiment_profile="${EXPERIMENT_PROFILE:-}"
evidence_locust_users="${EVIDENCE_LOCUST_USERS:-}"
evidence_locust_spawn_rate="${EVIDENCE_LOCUST_SPAWN_RATE:-}"
evidence_locust_run_seconds="${EVIDENCE_LOCUST_RUN_SECONDS:-}"
allow_dirty_worktree="${ALLOW_DIRTY_WORKTREE:-0}"

work_dir=""
capture_started=0
capture_finished=0
capture_start_timestamp=""
sample_count=0
failed_sample_count=0
warning_count=0
signal_name=""
final_validation_status="not-run"

usage() {
  cat >&2 <<'EOF'
Usage: EXPERIMENT_ID=<unique-name> \
       EXPERIMENT_PROFILE=<idle|load> \
       EVIDENCE_LOCUST_USERS=<non-negative-integer> \
       EVIDENCE_LOCUST_SPAWN_RATE=<non-negative-integer> \
       EVIDENCE_LOCUST_RUN_SECONDS=<non-negative-integer> \
       CAPTURE_DURATION_SECONDS=<positive-integer> \
       [SAMPLE_INTERVAL_SECONDS=<positive-integer>] \
       [ALLOW_DIRTY_WORKTREE=0|1] \
       ./scripts/capture-resource-usage.sh <new-output-directory>

The EVIDENCE_LOCUST_* values are labels written to metadata.json. They do not
configure or control the long-running Locust UI. The idle profile requires all
three labels to be 0; the load profile requires all three to be positive.
Acceptance captures require a clean Git worktree. ALLOW_DIRTY_WORKTREE=1 is
only for local development smoke tests and is recorded in metadata.json.
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

is_positive_integer "$interval" || \
  die "SAMPLE_INTERVAL_SECONDS must be a positive integer"
is_positive_integer "$duration" || \
  die "CAPTURE_DURATION_SECONDS must be a positive integer"
is_valid_identifier "$experiment_id" || \
  die "EXPERIMENT_ID must be 1-128 letters, digits, dots, underscores, or hyphens and start with a letter or digit"
[[ "$experiment_profile" == "idle" || "$experiment_profile" == "load" ]] || \
  die "EXPERIMENT_PROFILE must be idle or load"
is_non_negative_integer "$evidence_locust_users" || \
  die "EVIDENCE_LOCUST_USERS must be a non-negative integer"
is_non_negative_integer "$evidence_locust_spawn_rate" || \
  die "EVIDENCE_LOCUST_SPAWN_RATE must be a non-negative integer"
is_non_negative_integer "$evidence_locust_run_seconds" || \
  die "EVIDENCE_LOCUST_RUN_SECONDS must be a non-negative integer"
[[ "$allow_dirty_worktree" == "0" || "$allow_dirty_worktree" == "1" ]] || \
  die "ALLOW_DIRTY_WORKTREE must be 0 or 1"

if [[ "$experiment_profile" == "idle" ]]; then
  (( evidence_locust_users == 0 && evidence_locust_spawn_rate == 0 &&
     evidence_locust_run_seconds == 0 )) || \
    die "the idle profile requires all Locust metadata labels to be 0"
else
  (( evidence_locust_users > 0 && evidence_locust_spawn_rate > 0 &&
     evidence_locust_run_seconds > 0 )) || \
    die "the load profile requires positive Locust user, spawn-rate, and run-duration metadata labels"
fi

for required_command in kubectl jq awk date mktemp timeout git sha256sum; do
  command -v "$required_command" >/dev/null 2>&1 || \
    die "required command is not available: $required_command"
done

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if ! git_revision="$(git -C "$repository_root" rev-parse HEAD 2>/dev/null)"; then
  die "could not determine the repository revision"
fi
if ! git_status="$(git -C "$repository_root" status --porcelain --untracked-files=normal 2>/dev/null)"; then
  die "could not determine whether the Git worktree is clean"
fi
git_dirty=false
if [[ -n "$git_status" ]]; then
  git_dirty=true
fi
if [[ "$git_dirty" == "true" && "$allow_dirty_worktree" != "1" ]]; then
  die "acceptance captures require a clean Git worktree; ALLOW_DIRTY_WORKTREE=1 is for development smoke tests only"
fi
dirty_worktree_override=false
if [[ "$allow_dirty_worktree" == "1" ]]; then
  dirty_worktree_override=true
fi

work_dir="$(mktemp -d /tmp/autoscaling-resource-capture.XXXXXX)" || \
  die "could not create a private temporary directory"

simulator_deployment_json="$work_dir/simulator-deployment.json"
locust_deployment_json="$work_dir/locust-deployment.json"
hpa_json="$work_dir/hpa.json"
simulator_pods_preflight_json="$work_dir/simulator-pods-preflight.json"
locust_pods_preflight_json="$work_dir/locust-pods-preflight.json"

if ! run_kubectl get deployment "$simulator_deployment" \
  --namespace "$simulator_namespace" --output json \
  > "$simulator_deployment_json" 2> "$work_dir/preflight-simulator.err"; then
  die "read-only preflight could not read the simulator Deployment"
fi
if ! run_kubectl get deployment "$locust_deployment" \
  --namespace "$locust_namespace" --output json \
  > "$locust_deployment_json" 2> "$work_dir/preflight-locust.err"; then
  die "read-only preflight could not read the Locust Deployment"
fi
if ! run_kubectl get horizontalpodautoscalers.autoscaling --all-namespaces \
  --output json > "$hpa_json" 2> "$work_dir/preflight-hpa.err"; then
  die "read-only preflight could not verify that the sizing targets are not autoscaled"
fi
if ! run_kubectl get pods --namespace "$simulator_namespace" \
  --selector "$simulator_selector" --output json \
  > "$simulator_pods_preflight_json" 2> "$work_dir/preflight-simulator-pods.err"; then
  die "read-only preflight could not read simulator Pods"
fi
if ! run_kubectl get pods --namespace "$locust_namespace" \
  --selector "$locust_selector" --output json \
  > "$locust_pods_preflight_json" 2> "$work_dir/preflight-locust-pods.err"; then
  die "read-only preflight could not read Locust Pods"
fi

deployment_is_settled "$simulator_deployment_json" "$simulator_container" || \
  die "simulator Deployment must be fully observed and settled at exactly one updated, current, Ready, and available replica"
deployment_is_settled "$locust_deployment_json" "$locust_container" || \
  die "Locust Deployment must be fully observed and settled at exactly one updated, current, Ready, and available replica"
pod_is_settled "$simulator_pods_preflight_json" "$simulator_container" || \
  die "simulator must have exactly one running, Ready Pod with a resolved runtime image ID"
pod_is_settled "$locust_pods_preflight_json" "$locust_container" || \
  die "Locust must have exactly one running, Ready Pod with a resolved runtime image ID"
hpa_state_is_valid "$hpa_json" || \
  die "Phase 6 sizing requires both the simulator and Locust Deployments to have no HPA"

simulator_deployment_fingerprint="$(deployment_fingerprint "$simulator_deployment_json")" || \
  die "could not fingerprint the simulator Deployment"
locust_deployment_fingerprint="$(deployment_fingerprint "$locust_deployment_json")" || \
  die "could not fingerprint the Locust Deployment"
simulator_runtime_image_id="$(runtime_image_id "$simulator_pods_preflight_json" "$simulator_container")" || \
  die "could not record the simulator runtime image ID"
locust_runtime_image_id="$(runtime_image_id "$locust_pods_preflight_json" "$locust_container")" || \
  die "could not record the Locust runtime image ID"
locust_runtime_identity="$(runtime_identity "$locust_pods_preflight_json" "$locust_container")" || \
  die "could not record the Locust Pod and container identity"

if ! run_kubectl top pods --namespace "$simulator_namespace" \
  --selector "$simulator_selector" --containers --no-headers \
  > "$work_dir/preflight-simulator-top.txt" 2> "$work_dir/preflight-simulator-top.err"; then
  die "Metrics API preflight failed for simulator Pods"
fi
if ! awk -v container="$simulator_container" '$2 == container { found=1 } END { exit !found }' \
  "$work_dir/preflight-simulator-top.txt"; then
  die "Metrics API has no sample for the simulator container"
fi
if ! run_kubectl top pods --namespace "$locust_namespace" \
  --selector "$locust_selector" --containers --no-headers \
  > "$work_dir/preflight-locust-top.txt" 2> "$work_dir/preflight-locust-top.err"; then
  die "Metrics API preflight failed for the Locust Pod"
fi
if ! awk -v container="$locust_container" '$2 == container { found=1 } END { exit !found }' \
  "$work_dir/preflight-locust-top.txt"; then
  die "Metrics API has no sample for the Locust container"
fi

# Reserve the directory atomically after every validation and cluster preflight.
if ! mkdir -- "$output_dir"; then
  die "could not create the new output directory (it may now exist)"
fi

capture_start_timestamp="$(date --utc --iso-8601=seconds)"
capture_started=1

metadata_tmp="$work_dir/metadata.json"
if ! jq -n \
  --slurpfile simulator "$simulator_deployment_json" \
  --slurpfile locust "$locust_deployment_json" \
  --slurpfile simulator_pods "$simulator_pods_preflight_json" \
  --slurpfile locust_pods "$locust_pods_preflight_json" \
  --arg schema_version "2" \
  --arg experiment_id "$experiment_id" \
  --arg profile "$experiment_profile" \
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
  --arg simulator_fingerprint "$simulator_deployment_fingerprint" \
  --arg locust_fingerprint "$locust_deployment_fingerprint" \
  --arg simulator_image_id "$simulator_runtime_image_id" \
  --arg locust_image_id "$locust_runtime_image_id" \
  '{
    schemaVersion: $schema_version,
    experimentId: $experiment_id,
    profile: $profile,
    captureStartedAt: $started_at,
    captureDurationSeconds: $duration_seconds,
    sampleIntervalSeconds: $sample_interval_seconds,
    source: {
      gitRevision: $git_revision,
      worktreeDirty: $git_dirty,
      dirtyWorktreeOverride: $dirty_allowed
    },
    locustUiLabels: {
      users: $locust_users,
      spawnRate: $locust_spawn_rate,
      runSeconds: $locust_run_seconds,
      metadataOnly: true,
      notice: "These values describe the intended Locust UI settings; this script does not configure Locust."
    },
    simulator: {
      namespace: $simulator[0].metadata.namespace,
      deployment: $simulator[0].metadata.name,
      deploymentUid: $simulator[0].metadata.uid,
      deploymentGeneration: $simulator[0].metadata.generation,
      deploymentIdentitySpecSha256: $simulator_fingerprint,
      replicasAtPreflight: $simulator[0].spec.replicas,
      container: ($simulator[0].spec.template.spec.containers[] | select(.name == $simulator_container) |
        {name, image, resources}),
      runningPodAtPreflight: ($simulator_pods[0].items[0] |
        (.status.containerStatuses[] | select(.name == $simulator_container)) as $status |
        {
          name: .metadata.name,
          uid: .metadata.uid,
          node: .spec.nodeName,
          image: $status.image,
          imageId: $simulator_image_id,
          containerId: $status.containerID,
          restartCount: $status.restartCount
        })
    },
    locust: {
      namespace: $locust[0].metadata.namespace,
      deployment: $locust[0].metadata.name,
      deploymentUid: $locust[0].metadata.uid,
      deploymentGeneration: $locust[0].metadata.generation,
      deploymentIdentitySpecSha256: $locust_fingerprint,
      replicasAtPreflight: $locust[0].spec.replicas,
      container: ($locust[0].spec.template.spec.containers[] | select(.name == $locust_container) |
        {name, image, resources}),
      runningPodAtPreflight: ($locust_pods[0].items[0] |
        (.status.containerStatuses[] | select(.name == $locust_container)) as $status |
        {
          name: .metadata.name,
          uid: .metadata.uid,
          node: .spec.nodeName,
          image: $status.image,
          imageId: $locust_image_id,
          containerId: $status.containerID,
          restartCount: $status.restartCount
        })
    },
    throttlingCounters: {
      cumulative: true,
      resetOnContainerRestart: true,
      analysisRequirement: "Calculate deltas only within the same containerId and account for restarts."
    }
  }' > "$metadata_tmp"; then
  die "could not create experiment metadata"
fi
if ! mv -- "$metadata_tmp" "$output_dir/metadata.json"; then
  die "could not publish experiment metadata"
fi

resource_file="$output_dir/resources.csv"
replica_file="$output_dir/replicas.csv"
pod_file="$output_dir/simulator-pods.csv"
throttling_file="$output_dir/simulator-throttling.csv"
sample_status_file="$output_dir/sample-status.csv"

printf 'timestamp,component,namespace,pod,container,cpu,memory\n' > "$resource_file" || die "could not initialize resources.csv"
printf 'timestamp,desired,current,available,ready\n' > "$replica_file" || die "could not initialize replicas.csv"
printf 'timestamp,pod,pod_uid,node,phase,pod_ready,container_ready,restart_count,container_id\n' > "$pod_file" || die "could not initialize simulator-pods.csv"
printf 'timestamp,pod,container,container_id,restart_count,cgroup_version,nr_periods,nr_throttled,throttled_time_raw,throttled_time_unit,throttled_seconds,status\n' > "$throttling_file" || die "could not initialize simulator-throttling.csv"
printf 'scheduled_at,sample_started_at,sample_ended_at,sample_number,status,simulator_resources,locust_resources,replicas,simulator_pods,throttling\n' > "$sample_status_file" || die "could not initialize sample-status.csv"

printf 'Capturing %s for %s seconds every %s seconds.\n' \
  "$experiment_id" "$duration" "$interval"
printf 'Locust values are metadata only; configure and stop the run in the web UI.\n'

start_epoch="$(date +%s)"
end_epoch=$(( start_epoch + duration ))
next_deadline_epoch="$start_epoch"
while (( next_deadline_epoch < end_epoch )); do
  now_epoch="$(date +%s)"
  if (( now_epoch < next_deadline_epoch )); then
    sleep "$(( next_deadline_epoch - now_epoch ))"
  fi

  scheduled_at="$(date --utc --iso-8601=seconds --date="@${next_deadline_epoch}")"
  sample_started_at="$(date --utc --iso-8601=seconds)"
  (( sample_count += 1 ))

  simulator_resources_status="$(capture_resources simulator "$simulator_namespace" "$simulator_selector" "$simulator_container")"
  simulator_resources_exit=$?
  locust_resources_status="$(capture_resources locust "$locust_namespace" "$locust_selector" "$locust_container")"
  locust_resources_exit=$?
  replicas_status="$(capture_replicas)"
  replicas_exit=$?
  pods_status="$(capture_simulator_pods)"
  pods_exit=$?
  throttling_status="$(capture_throttling)"
  throttling_exit=$?
  sample_ended_at="$(date --utc --iso-8601=seconds)"

  sample_status="ok"
  if (( simulator_resources_exit != 0 || locust_resources_exit != 0 ||
        replicas_exit != 0 || pods_exit != 0 || throttling_exit != 0 )); then
    sample_status="failed"
    (( failed_sample_count += 1 ))
  elif [[ "$throttling_status" != "ok" ]]; then
    sample_status="ok-with-warning"
  fi

  if ! printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$scheduled_at" "$sample_started_at" "$sample_ended_at" \
    "$sample_count" "$sample_status" \
    "$simulator_resources_status" "$locust_resources_status" \
    "$replicas_status" "$pods_status" "$throttling_status" >> "$sample_status_file"; then
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

final_validation_exit=0
validate_final_state || final_validation_exit=$?

if (( sample_count == 0 )); then
  printf 'error: capture ended without any samples\n' >&2
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
