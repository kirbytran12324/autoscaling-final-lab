#!/usr/bin/env bash

set -euo pipefail

namespace="${RUNNER_NAMESPACE:-autoscaling-lab}"
job_name="${RUNNER_JOB_NAME:-tournament-runner}"
expected_job_name="tournament-runner"
pvc_name="${RUNNER_PVC_NAME:-tournament-state}"
deployment_name="${SIMULATOR_DEPLOYMENT_NAME:-metronome-simulator}"
expected_context="${EXPECTED_KUBE_CONTEXT:-docker-desktop}"

# The sample runner writes a provisional checkpoint after every accepted result.
# Ten results gives us an early but meaningful interruption point.
interrupt_after="${INTERRUPT_AFTER_RESULTS:-10}"

pod_start_timeout="${POD_START_TIMEOUT_SECONDS:-60}"
checkpoint_timeout="${CHECKPOINT_TIMEOUT_SECONDS:-90}"
replacement_timeout="${REPLACEMENT_TIMEOUT_SECONDS:-120}"
completion_timeout="${COMPLETION_TIMEOUT_SECONDS:-300}"

script_dir="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  pwd
)"
repository_root="$(
  cd -- "${script_dir}/.."
  pwd
)"

kustomize_dir="${RUNNER_KUSTOMIZE_DIR:-${repository_root}/k8s/jobs/runner}"
output_dir="${1:-${repository_root}/evidence/experiments/sample-restart-resume}"

first_pod=""
first_pod_uid=""
first_log_pid=""
replacement_pod=""
replacement_pod_uid=""

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 ||
    die "Required command not found: $1"
}

require_positive_integer() {
  local variable_name="$1"
  local value="$2"

  [[ "$value" =~ ^[1-9][0-9]*$ ]] ||
    die "${variable_name} must be a positive integer; received: ${value}"
}

validate_rendered_runner_job() {
  local manifest_path="$1"
  local selected_job=""

  [[ "${job_name}" == "${expected_job_name}" ]] ||
    die "RUNNER_JOB_NAME must be ${expected_job_name}; received: ${job_name}"

  if ! selected_job="$(
    kubectl create --dry-run=client --validate=false \
      -f "${manifest_path}" \
      -o go-template='{{if eq .kind "Job"}}{{.metadata.name}}{{"\t"}}{{range .spec.template.spec.containers}}{{range .env}}{{if eq .name "TOURNAMENT_MODE"}}{{.value}}{{end}}{{end}}{{end}}{{"\n"}}{{end}}'
  )"; then
    die "Rendered runner manifests failed client-side decoding"
  fi

  if [[ "${selected_job}" != $'tournament-runner\tsample' ]]; then
    die "Rendered workload must contain exactly the tournament-runner Job with TOURNAMENT_MODE=sample"
  fi
}

capture_cluster_evidence() {
  local exit_status=$?

  set +e

  if [[ -n "${first_log_pid}" ]] &&
    kill -0 "${first_log_pid}" >/dev/null 2>&1; then
    kill "${first_log_pid}" >/dev/null 2>&1
    wait "${first_log_pid}" >/dev/null 2>&1
  fi

  kubectl -n "${namespace}" get job "${job_name}" -o yaml \
    >"${output_dir}/job-final.yaml" 2>&1

  kubectl -n "${namespace}" describe job "${job_name}" \
    >"${output_dir}/job-describe.txt" 2>&1

  kubectl -n "${namespace}" get pods \
    -l "job-name=${job_name}" \
    -o yaml \
    >"${output_dir}/runner-pods-final.yaml" 2>&1

  kubectl -n "${namespace}" get events \
    --sort-by='.metadata.creationTimestamp' \
    >"${output_dir}/namespace-events.txt" 2>&1

  trap - EXIT
  exit "${exit_status}"
}

wait_for_first_runner_pod() {
  local deadline=$((SECONDS + pod_start_timeout))
  local pod_name=""

  while ((SECONDS < deadline)); do
    pod_name="$(
      kubectl -n "${namespace}" get pods \
        -l "job-name=${job_name}" \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true
    )"

    if [[ -n "${pod_name}" ]]; then
      printf '%s\n' "${pod_name}"
      return 0
    fi

    sleep 1
  done

  return 1
}

wait_for_replacement_pod() {
  local deadline=$((SECONDS + replacement_timeout))
  local pod_names=""
  local candidate=""

  while ((SECONDS < deadline)); do
    pod_names="$(
      kubectl -n "${namespace}" get pods \
        -l "job-name=${job_name}" \
        -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' \
        2>/dev/null || true
    )"

    while IFS= read -r candidate; do
      if [[ -n "${candidate}" && "${candidate}" != "${first_pod}" ]]; then
        printf '%s\n' "${candidate}"
        return 0
      fi
    done <<<"${pod_names}"

    sleep 1
  done

  return 1
}

for command_name in kubectl grep find tee; do
  require_command "${command_name}"
done

require_positive_integer "INTERRUPT_AFTER_RESULTS" "${interrupt_after}"
require_positive_integer "POD_START_TIMEOUT_SECONDS" "${pod_start_timeout}"
require_positive_integer "CHECKPOINT_TIMEOUT_SECONDS" "${checkpoint_timeout}"
require_positive_integer "REPLACEMENT_TIMEOUT_SECONDS" "${replacement_timeout}"
require_positive_integer "COMPLETION_TIMEOUT_SECONDS" "${completion_timeout}"

[[ -d "${kustomize_dir}" ]] ||
  die "Runner Kustomize directory does not exist: ${kustomize_dir}"

if [[ -d "${output_dir}" ]] &&
  [[ -n "$(find "${output_dir}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  die "Evidence directory is not empty: ${output_dir}"
fi

mkdir -p "${output_dir}"
trap capture_cluster_evidence EXIT

echo "Rendering runner manifests..."
kubectl kustomize "${kustomize_dir}" \
  >"${output_dir}/runner-rendered.yaml"

if grep -q -- '--check-config' "${output_dir}/runner-rendered.yaml"; then
  die "The runner manifest still contains --check-config. Refusing to start a real tournament."
fi

validate_rendered_runner_job "${output_dir}/runner-rendered.yaml"

current_context="$(kubectl config current-context)"

if [[ -n "${expected_context}" &&
  "${current_context}" != "${expected_context}" ]]; then
  die "Current Kubernetes context is '${current_context}', expected '${expected_context}'"
fi

kubectl get namespace "${namespace}" >/dev/null

if kubectl -n "${namespace}" get job "${job_name}" >/dev/null 2>&1; then
  die "Job ${namespace}/${job_name} already exists. Inspect or delete it manually before running this experiment."
fi

pvc_phase="$(
  kubectl -n "${namespace}" get pvc "${pvc_name}" \
    -o jsonpath='{.status.phase}'
)"

[[ "${pvc_phase}" == "Bound" ]] ||
  die "PVC ${namespace}/${pvc_name} is not Bound; current phase: ${pvc_phase}"

available_replicas="$(
  kubectl -n "${namespace}" get deployment "${deployment_name}" \
    -o jsonpath='{.status.availableReplicas}'
)"

available_replicas="${available_replicas:-0}"

[[ "${available_replicas}" =~ ^[0-9]+$ ]] ||
  die "Could not determine available simulator replicas"

((available_replicas >= 1)) ||
  die "Simulator Deployment has no available replicas"

echo "Validating manifests against the Kubernetes API..."
kubectl apply --dry-run=server -k "${kustomize_dir}" \
  | tee "${output_dir}/server-dry-run.txt"

echo "Starting the sample tournament..."
kubectl apply -k "${kustomize_dir}" \
  | tee "${output_dir}/apply.txt"

first_pod="$(wait_for_first_runner_pod)" ||
  die "Runner Pod was not created within ${pod_start_timeout} seconds"

first_pod_uid="$(
  kubectl -n "${namespace}" get pod "${first_pod}" \
    -o jsonpath='{.metadata.uid}'
)"

kubectl -n "${namespace}" get pod "${first_pod}" -o yaml \
  >"${output_dir}/first-pod.yaml"

echo "Waiting for first runner Pod ${first_pod}..."
kubectl -n "${namespace}" wait \
  --for=condition=Ready \
  "pod/${first_pod}" \
  --timeout="${pod_start_timeout}s"

kubectl -n "${namespace}" logs -f "${first_pod}" \
  >"${output_dir}/first-pod.log" 2>&1 &
first_log_pid=$!

checkpoint_watch_js="$(cat <<'NODE'
const fs = require("node:fs");

const threshold = Number(process.argv[1]);
const timeoutMs = Number(process.argv[2]) * 1000;
const stateRoot = process.env.TOURNAMENT_STATE_ROOT;
const runId = process.env.TOURNAMENT_RUN_ID;

if (!stateRoot || !runId) {
  console.error("Runner state environment variables are missing");
  process.exit(2);
}

const checkpointPath =
  `${stateRoot}/runs/${runId}/checkpoint.json`;

const deadline = Date.now() + timeoutMs;

function poll() {
  try {
    const contents = fs.readFileSync(checkpointPath, "utf8");
    const checkpoint = JSON.parse(contents);

    if (
      checkpoint.stage === "groups" &&
      Number.isInteger(checkpoint.acceptedResultCount) &&
      checkpoint.acceptedResultCount >= threshold
    ) {
      console.log(JSON.stringify(checkpoint, null, 2));
      process.exit(0);
    }

    if (checkpoint.stage !== "groups") {
      console.error(
        `Group stage ended before the interruption threshold was observed: ` +
        `stage=${checkpoint.stage}, ` +
        `acceptedResultCount=${checkpoint.acceptedResultCount}`
      );
      process.exit(3);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(
        `Unable to read checkpoint ${checkpointPath}: ${error.message}`
      );
      process.exit(4);
    }
  }

  if (Date.now() >= deadline) {
    console.error(
      `Timed out waiting for ${threshold} accepted group-stage results`
    );
    process.exit(5);
  }

  setTimeout(poll, 25);
}

poll();
NODE
)"

echo "Waiting for a durable group-stage checkpoint with at least ${interrupt_after} accepted results..."

kubectl -n "${namespace}" exec "${first_pod}" -- \
  node --eval "${checkpoint_watch_js}" \
  "${interrupt_after}" \
  "${checkpoint_timeout}" \
  | tee "${output_dir}/checkpoint-before-interruption.json"

first_pod_phase="$(
  kubectl -n "${namespace}" get pod "${first_pod}" \
    -o jsonpath='{.status.phase}'
)"

[[ "${first_pod_phase}" == "Running" ]] ||
  die "First runner Pod is no longer Running; refusing to perform the planned interruption"

echo "Checkpoint is durable. Deleting only runner Pod ${first_pod}..."
kubectl -n "${namespace}" delete pod "${first_pod}" --wait=true \
  | tee "${output_dir}/pod-deletion.txt"

if [[ -n "${first_log_pid}" ]]; then
  wait "${first_log_pid}" >/dev/null 2>&1 || true
  first_log_pid=""
fi

echo "Waiting for the Job controller to create a replacement Pod..."
replacement_pod="$(wait_for_replacement_pod)" ||
  die "No replacement Pod appeared within ${replacement_timeout} seconds"

replacement_pod_uid="$(
  kubectl -n "${namespace}" get pod "${replacement_pod}" \
    -o jsonpath='{.metadata.uid}'
)"

[[ "${replacement_pod_uid}" != "${first_pod_uid}" ]] ||
  die "Replacement Pod unexpectedly has the same UID as the interrupted Pod"

kubectl -n "${namespace}" get pod "${replacement_pod}" -o yaml \
  >"${output_dir}/replacement-pod-initial.yaml"

echo "Replacement Pod: ${replacement_pod}"

echo "Waiting for the resumed tournament to complete..."
kubectl -n "${namespace}" wait \
  --for=condition=Complete \
  "job/${job_name}" \
  --timeout="${completion_timeout}s"

kubectl -n "${namespace}" logs "${replacement_pod}" \
  >"${output_dir}/replacement-pod.log" 2>&1

run_id="$(
  kubectl -n "${namespace}" get job "${job_name}" \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="TOURNAMENT_RUN_ID")].value}'
)"

cat >"${output_dir}/summary.txt" <<EOF
result=job-completed
namespace=${namespace}
job=${job_name}
run_id=${run_id}
interruption_stage=groups
interruption_threshold=${interrupt_after}
first_pod=${first_pod}
first_pod_uid=${first_pod_uid}
replacement_pod=${replacement_pod}
replacement_pod_uid=${replacement_pod_uid}
pvc=${pvc_name}
pvc_preserved=true
job_preserved=true
artifact_audit_required=true
EOF

echo
echo "Restart/resume orchestration test completed."
echo "Evidence directory: ${output_dir}"
echo
echo "The Job and PVC were deliberately preserved."
echo "Next, audit the persisted run artifacts for:"
echo "  - the same immutable roster"
echo "  - no duplicate accepted match IDs"
echo "  - consistent accepted-result counts"
echo "  - completed group and knockout stages"
echo "  - the final offline report"
