#!/usr/bin/env bash
# Resource capture policy helpers; uses the entry script configuration.
# shellcheck disable=SC2034

capture_resources() {
  local component="$1"
  local namespace="$2"
  local selector="$3"
  local container="$4"
  local timestamp
  local raw_file="$work_dir/top-${component}.txt"
  local parsed_file="$work_dir/top-${component}.csv"

  if ! run_kubectl top pods --namespace "$namespace" --selector "$selector" \
    --containers --no-headers > "$raw_file" 2> "$work_dir/top-${component}.err"; then
    printf 'failed'
    return 1
  fi

  timestamp="$(date --utc --iso-8601=seconds)"

  if ! awk -v timestamp="$timestamp" -v component="$component" \
    -v namespace_value="$namespace" -v container="$container" '
      BEGIN { OFS="," }
      $2 == container { print timestamp, component, namespace_value, $1, $2, $3, $4; found=1 }
      END { if (!found) exit 1 }
    ' "$raw_file" > "$parsed_file"; then
    printf 'missing-container'
    return 1
  fi

  if ! command awk 'NF' "$parsed_file" >> "$resource_file"; then
    printf 'write-failed'
    return 1
  fi
  printf 'ok'
}

capture_replicas() {
  local timestamp
  local deployment_file="$work_dir/deployment-sample.json"
  local parsed_file="$work_dir/replicas-sample.csv"

  if ! run_kubectl get deployment "$simulator_deployment" \
    --namespace "$simulator_namespace" --output json \
    > "$deployment_file" 2> "$work_dir/deployment-sample.err"; then
    printf 'failed'
    return 1
  fi
  timestamp="$(date --utc --iso-8601=seconds)"
  if ! jq -er --arg timestamp "$timestamp" '
    [$timestamp, .spec.replicas, (.status.replicas // 0),
     (.status.availableReplicas // 0), (.status.readyReplicas // 0)] | @csv
  ' "$deployment_file" > "$parsed_file"; then
    printf 'parse-failed'
    return 1
  fi
  if ! command awk '{gsub(/"/, ""); print}' "$parsed_file" >> "$replica_file"; then
    printf 'write-failed'
    return 1
  fi
  printf 'ok'
}

capture_simulator_pods() {
  local timestamp
  local pods_json="$work_dir/pods-sample.json"
  local parsed_file="$work_dir/pods-sample.csv"

  if ! run_kubectl get pods --namespace "$simulator_namespace" \
    --selector "$simulator_selector" --output json \
    > "$pods_json" 2> "$work_dir/pods-sample.err"; then
    printf 'failed'
    return 1
  fi
  timestamp="$(date --utc --iso-8601=seconds)"
  if ! jq -er --arg timestamp "$timestamp" --arg container "$simulator_container" '
    if (.items | length) == 0 then error("no simulator pods") else . end |
    .items[] |
    (.status.containerStatuses // [] | map(select(.name == $container)) | first) as $status |
    (.status.conditions // [] | map(select(.type == "Ready")) | first) as $ready |
    [$timestamp, .metadata.name, .metadata.uid, (.spec.nodeName // ""),
     (.status.phase // "Unknown"), ($ready.status // "Unknown"),
     ($status.ready // false),
     ($status.restartCount // 0), ($status.containerID // "")] | @csv
  ' "$pods_json" > "$parsed_file"; then
    printf 'parse-failed'
    return 1
  fi
  if ! command awk '{gsub(/"/, ""); print}' "$parsed_file" >> "$pod_file"; then
    printf 'write-failed'
    return 1
  fi
  printf 'ok'
}

capture_throttling() {
  local timestamp
  local pods_json="$work_dir/pods-sample.json"
  local pod_rows="$work_dir/throttling-pods.tsv"
  local stat_file="$work_dir/cpu.stat"
  local parsed_file="$work_dir/throttling-sample.csv"
  local pod container_id restart_count
  local nr_periods nr_throttled raw unit seconds version
  local available_count=0
  local unavailable_count=0

  : > "$parsed_file"
  if [[ ! -s "$pods_json" ]] || ! jq -er --arg container "$simulator_container" '
    .items[] |
    (.status.containerStatuses // [] | map(select(.name == $container)) | first) as $status |
    [.metadata.name, ($status.containerID // ""), ($status.restartCount // 0)] | @tsv
  ' "$pods_json" > "$pod_rows"; then
    printf 'unavailable'
    return 0
  fi

  while IFS=$'\t' read -r pod container_id restart_count; do
    [[ -n "$pod" ]] || continue
    if [[ -z "$container_id" ]]; then
      timestamp="$(date --utc --iso-8601=seconds)"
      printf '%s,%s,%s,,%s,,,,,,,unavailable-no-container-id\n' \
        "$timestamp" "$pod" "$simulator_container" "$restart_count" >> "$parsed_file"
      (( unavailable_count += 1 ))
      continue
    fi

    if ! timeout "${kubectl_timeout_seconds}s" kubectl \
      --request-timeout="${kubectl_timeout_seconds}s" exec \
      --namespace "$simulator_namespace" "$pod" --container "$simulator_container" \
      -- cat /sys/fs/cgroup/cpu.stat > "$stat_file" 2> "$work_dir/cpu-stat.err"; then
      if ! timeout "${kubectl_timeout_seconds}s" kubectl \
        --request-timeout="${kubectl_timeout_seconds}s" exec \
        --namespace "$simulator_namespace" "$pod" --container "$simulator_container" \
        -- cat /sys/fs/cgroup/cpu/cpu.stat > "$stat_file" 2> "$work_dir/cpu-stat.err"; then
        timestamp="$(date --utc --iso-8601=seconds)"
        printf '%s,%s,%s,%s,%s,,,,,,,unavailable-cgroup-stats\n' \
          "$timestamp" "$pod" "$simulator_container" "$container_id" "$restart_count" >> "$parsed_file"
        (( unavailable_count += 1 ))
        continue
      fi
    fi

    timestamp="$(date --utc --iso-8601=seconds)"
    nr_periods="$(awk '$1 == "nr_periods" {print $2}' "$stat_file")"
    nr_throttled="$(awk '$1 == "nr_throttled" {print $2}' "$stat_file")"
    raw="$(awk '$1 == "throttled_usec" {print $2}' "$stat_file")"
    if [[ -n "$raw" ]]; then
      version="v2"
      unit="microseconds"
      seconds="$(awk -v value="$raw" 'BEGIN { printf "%.6f", value / 1000000 }')"
    else
      raw="$(awk '$1 == "throttled_time" {print $2}' "$stat_file")"
      version="v1"
      unit="nanoseconds"
      seconds="$(awk -v value="$raw" 'BEGIN { printf "%.9f", value / 1000000000 }')"
    fi

    if [[ -z "$nr_periods" || -z "$nr_throttled" || -z "$raw" ]]; then
      printf '%s,%s,%s,%s,%s,,,,,,,unavailable-unrecognized-cgroup-stats\n' \
        "$timestamp" "$pod" "$simulator_container" "$container_id" "$restart_count" >> "$parsed_file"
      (( unavailable_count += 1 ))
      continue
    fi

    printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,ok\n' \
      "$timestamp" "$pod" "$simulator_container" "$container_id" "$restart_count" \
      "$version" "$nr_periods" "$nr_throttled" "$raw" "$unit" "$seconds" >> "$parsed_file"
    (( available_count += 1 ))
  done < "$pod_rows"

  if ! command awk 'NF' "$parsed_file" >> "$throttling_file"; then
    printf 'write-failed'
    return 1
  fi
  if (( unavailable_count > 0 )); then
    if (( available_count > 0 )); then
      printf 'partial'
    else
      printf 'unavailable'
    fi
  else
    printf 'ok'
  fi
}

validate_final_state() {
  local simulator_end="$work_dir/simulator-deployment-final.json"
  local locust_end="$work_dir/locust-deployment-final.json"
  local hpa_end="$work_dir/hpa-final.json"
  local simulator_pods_end="$work_dir/simulator-pods-final.json"
  local locust_pods_end="$work_dir/locust-pods-final.json"
  local fingerprint image_id runtime_identity_value

  final_validation_status="simulator-deployment-read-failed"
  run_kubectl get deployment "$simulator_deployment" \
    --namespace "$simulator_namespace" --output json \
    > "$simulator_end" 2> "$work_dir/final-simulator.err" || return 1

  final_validation_status="locust-deployment-read-failed"
  run_kubectl get deployment "$locust_deployment" \
    --namespace "$locust_namespace" --output json \
    > "$locust_end" 2> "$work_dir/final-locust.err" || return 1

  final_validation_status="simulator-pods-read-failed"
  run_kubectl get pods --namespace "$simulator_namespace" \
    --selector "$simulator_selector" --output json \
    > "$simulator_pods_end" 2> "$work_dir/final-simulator-pods.err" || return 1

  final_validation_status="locust-pods-read-failed"
  run_kubectl get pods --namespace "$locust_namespace" \
    --selector "$locust_selector" --output json \
    > "$locust_pods_end" 2> "$work_dir/final-locust-pods.err" || return 1

  final_validation_status="hpa-read-failed"
  run_kubectl get horizontalpodautoscalers.autoscaling --all-namespaces \
    --output json > "$hpa_end" 2> "$work_dir/final-hpa.err" || return 1

  final_validation_status="simulator-deployment-not-settled"
  deployment_is_settled "$simulator_end" "$simulator_container" || return 1
  final_validation_status="locust-deployment-not-settled"
  deployment_is_settled "$locust_end" "$locust_container" || return 1
  final_validation_status="simulator-pod-not-settled"
  pod_is_settled "$simulator_pods_end" "$simulator_container" || return 1
  final_validation_status="locust-pod-not-settled"
  pod_is_settled "$locust_pods_end" "$locust_container" || return 1

  final_validation_status="simulator-deployment-changed"
  fingerprint="$(deployment_fingerprint "$simulator_end")" || return 1
  [[ "$fingerprint" == "$simulator_deployment_fingerprint" ]] || return 1
  final_validation_status="locust-deployment-changed"
  fingerprint="$(deployment_fingerprint "$locust_end")" || return 1
  [[ "$fingerprint" == "$locust_deployment_fingerprint" ]] || return 1

  final_validation_status="simulator-runtime-image-changed"
  image_id="$(runtime_image_id "$simulator_pods_end" "$simulator_container")" || return 1
  [[ "$image_id" == "$simulator_runtime_image_id" ]] || return 1
  final_validation_status="locust-runtime-image-changed"
  image_id="$(runtime_image_id "$locust_pods_end" "$locust_container")" || return 1
  [[ "$image_id" == "$locust_runtime_image_id" ]] || return 1
  final_validation_status="locust-container-lifetime-changed"
  runtime_identity_value="$(runtime_identity "$locust_pods_end" "$locust_container")" || return 1
  [[ "$runtime_identity_value" == "$locust_runtime_identity" ]] || return 1

  final_validation_status="hpa-assumption-changed"
  hpa_state_is_valid "$hpa_end" || return 1

  final_validation_status="ok"
  return 0
}
