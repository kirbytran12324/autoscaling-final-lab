#!/usr/bin/env bash

set -euo pipefail
umask 077

namespace="${RUNNER_NAMESPACE:-autoscaling-lab}"
pvc_name="${RUNNER_PVC_NAME:-tournament-state}"
exporter_image="${TOURNAMENT_EXPORTER_IMAGE:-metronome-simulator:phase10}"
refresh_report=0

if [[ "${1:-}" == "--refresh-report" ]]; then
  refresh_report=1
  shift
fi

run_id="${1:-}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${script_dir}/.." && pwd)"
evidence_root="${TOURNAMENT_EVIDENCE_ROOT:-${repository_root}/evidence/tournaments}"
runs_root="${evidence_root}/runs"
target_dir=""
work_root=""
exporter_pod=""
pod_created=0

usage() {
  cat >&2 <<'EOF'
Usage:
  bash scripts/export-tournament-run.sh <run-id>
  bash scripts/export-tournament-run.sh --refresh-report <run-id>

Copies one completed tournament run from the tournament-state PVC into
evidence/tournaments/runs/<run-id>/, validates it by generating report.html,
and writes SHA256SUMS. The destination must not already exist.

With --refresh-report, regenerates report.html and its provenance for an
already exported run without reading from or changing the Kubernetes PVC.

Reports use the current repository's simulator/src read-only while the
container image supplies the frozen Node.js runtime and dependencies.

Optional environment variables:
  RUNNER_NAMESPACE            Kubernetes namespace (default: autoscaling-lab)
  RUNNER_PVC_NAME             PVC name (default: tournament-state)
  TOURNAMENT_EXPORTER_IMAGE   Image used by the temporary read-only Pod and
                              local report container
                              (default: metronome-simulator:phase10)
  TOURNAMENT_EVIDENCE_ROOT    Absolute local evidence root
EOF
}

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

generate_report() {
  local run_directory="$1"

  docker run --rm \
    --network none \
    --read-only \
    --user "$(id -u):$(id -g)" \
    --mount "type=bind,source=${run_directory},target=/export/runs/${run_id}" \
    --mount "type=bind,source=${repository_root}/simulator/src,target=/app/src,readonly" \
    --env TOURNAMENT_STATE_ROOT=/export \
    --env TOURNAMENT_RUN_ID="$run_id" \
    "$exporter_image" node src/report-cli.js
}

write_report_provenance() {
  local run_directory="$1"
  local generator_revision generator_state image_id

  generator_revision="$(git -C "$repository_root" rev-parse HEAD)"
  image_id="$(docker image inspect --format '{{.Id}}' "$exporter_image")"
  generator_state=clean
  if [[ -n "$(git -C "$repository_root" status --porcelain -- simulator/src)" ]]; then
    generator_state=modified
  fi

  {
    printf 'report_source=repository-working-tree\n'
    printf 'git_revision=%s\n' "$generator_revision"
    printf 'git_simulator_src_state=%s\n' "$generator_state"
    printf 'runtime_image_reference=%s\n' "$exporter_image"
    printf 'runtime_image_id=%s\n' "$image_id"
  } >"${run_directory}/report-generator.txt"

  (
    cd -- "${repository_root}/simulator"
    find src -maxdepth 1 -type f -name '*.js' -print0 |
      sort -z |
      xargs -0 sha256sum
  ) >"${run_directory}/REPORT-GENERATOR-SHA256SUMS"
}

write_run_checksums() {
  local run_directory="$1"
  local -a checksum_files=()

  (
    cd -- "$run_directory"
    mapfile -d '' -t checksum_files < <(
      find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%f\0'
    )
    printf '%s\0' "${checksum_files[@]}" |
      sort -z |
      xargs -0 sha256sum >SHA256SUMS
    sha256sum --check SHA256SUMS
  )
}

cleanup() {
  local exit_status=$?
  trap - EXIT

  if [[ "$pod_created" == "1" && -n "$exporter_pod" ]]; then
    kubectl -n "$namespace" delete pod "$exporter_pod" \
      --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi

  if [[ -n "$work_root" && -d "$work_root" &&
        "$work_root" == "$evidence_root"/.export-"$run_id".* ]]; then
    rm -rf -- "$work_root"
  fi

  exit "$exit_status"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

[[ -n "$run_id" ]] || {
  usage
  exit 2
}
[[ "$#" == "1" ]] || {
  usage
  exit 2
}

[[ "$run_id" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] ||
  die "Run ID must be a lowercase DNS-style name of at most 63 characters"
[[ "$namespace" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] ||
  die "RUNNER_NAMESPACE is not a valid lowercase Kubernetes name"
[[ "$pvc_name" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] ||
  die "RUNNER_PVC_NAME is not a valid lowercase Kubernetes name"
[[ "$exporter_image" =~ ^[A-Za-z0-9._/:@-]+$ ]] ||
  die "TOURNAMENT_EXPORTER_IMAGE contains unsupported characters"
[[ "$evidence_root" == /* ]] ||
  die "TOURNAMENT_EVIDENCE_ROOT must be an absolute path"

for command_name in docker sha256sum find sort xargs git; do
  require_command "$command_name"
done

docker image inspect "$exporter_image" >/dev/null 2>&1 ||
  die "Container image is unavailable to Docker: ${exporter_image}"
[[ -f "${repository_root}/simulator/src/report-cli.js" ]] ||
  die "Current report source is unavailable under simulator/src"

mkdir -p -- "$runs_root"
target_dir="${runs_root}/${run_id}"

if [[ "$refresh_report" == "1" ]]; then
  [[ -d "$target_dir" ]] || die "Exported run does not exist: ${target_dir}"
  generate_report "$target_dir"
  write_report_provenance "$target_dir"
  write_run_checksums "$target_dir"

  printf 'Tournament report refreshed successfully.\n'
  printf '  Run ID: %s\n' "$run_id"
  printf '  Evidence: %s\n' "$target_dir"
  printf '  Report: %s/report.html\n' "$target_dir"
  exit 0
fi

for command_name in kubectl tar mktemp; do
  require_command "$command_name"
done

[[ "$(kubectl -n "$namespace" get pvc "$pvc_name" \
  -o jsonpath='{.status.phase}')" == "Bound" ]] ||
  die "PVC ${namespace}/${pvc_name} is not Bound"

[[ ! -e "$target_dir" ]] || die "Destination already exists: ${target_dir}"

work_root="$(mktemp -d "${evidence_root}/.export-${run_id}.XXXXXX")"
staging_run="${work_root}/runs/${run_id}"
mkdir -p -- "$staging_run"
exporter_pod="tournament-export-$(date +%s)-$$"

kubectl -n "$namespace" create -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${exporter_pod}
  labels:
    app: tournament-run-exporter
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: exporter
      image: ${exporter_image}
      imagePullPolicy: IfNotPresent
      command: [sh, -c, "sleep 3600"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: [ALL]
      resources:
        requests:
          cpu: 10m
          memory: 32Mi
        limits:
          cpu: 100m
          memory: 64Mi
      volumeMounts:
        - name: tournament-state
          mountPath: /data/tournaments
          readOnly: true
  volumes:
    - name: tournament-state
      persistentVolumeClaim:
        claimName: ${pvc_name}
        readOnly: true
EOF
pod_created=1

if ! kubectl -n "$namespace" wait \
  --for=condition=Ready "pod/${exporter_pod}" --timeout=120s; then
  kubectl -n "$namespace" describe pod "$exporter_pod" >&2 || true
  die "Exporter Pod did not become Ready"
fi

source_dir="/data/tournaments/runs/${run_id}"
kubectl -n "$namespace" exec "$exporter_pod" -- test -d "$source_dir" ||
  die "Run does not exist on PVC ${pvc_name}: ${run_id}"

kubectl -n "$namespace" cp "${exporter_pod}:${source_dir}/." "$staging_run"

generate_report "$staging_run"
write_report_provenance "$staging_run"
write_run_checksums "$staging_run"

mv -- "$staging_run" "$target_dir"

printf 'Tournament run exported successfully.\n'
printf '  Run ID: %s\n' "$run_id"
printf '  Evidence: %s\n' "$target_dir"
printf '  Report: %s/report.html\n' "$target_dir"
