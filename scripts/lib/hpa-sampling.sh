#!/usr/bin/env bash
# Hpa capture policy helpers; uses the entry script configuration.
# shellcheck disable=SC2034

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
