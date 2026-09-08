#!/usr/bin/env bash

set -uo pipefail

output_dir="${1:-evidence/experiments/manual-run}"
interval="${SAMPLE_INTERVAL_SECONDS:-15}"

mkdir -p "$output_dir"

resource_file="$output_dir/resources.csv"
replica_file="$output_dir/replicas.csv"

printf 'timestamp,component,pod,cpu,memory\n' > "$resource_file"
printf 'timestamp,desired,current,ready,available\n' > "$replica_file"

stop_capture() {
  printf '\nMetrics saved under %s\n' "$output_dir"
  exit 0
}

trap stop_capture INT TERM

while true; do
  timestamp="$(date --utc --iso-8601=seconds)"

  kubectl top pods \
    --namespace autoscaling-lab \
    --selector app=metronome-simulator \
    --no-headers 2>/dev/null |
    awk -v timestamp="$timestamp" '
      BEGIN { OFS="," }
      { print timestamp, "simulator", $1, $2, $3 }
    ' >> "$resource_file"

  kubectl top pods \
    --namespace load-testing \
    --selector app=metronome-load-test \
    --no-headers 2>/dev/null |
    awk -v timestamp="$timestamp" '
      BEGIN { OFS="," }
      { print timestamp, "load-generator", $1, $2, $3 }
    ' >> "$resource_file"

  replicas="$(
    kubectl get deployment metronome-simulator \
      --namespace autoscaling-lab \
      --output jsonpath='{.spec.replicas},{.status.replicas},{.status.readyReplicas},{.status.availableReplicas}' \
      2>/dev/null
  )"

  printf '%s,%s\n' "$timestamp" "$replicas" >> "$replica_file"

  sleep "$interval"
done