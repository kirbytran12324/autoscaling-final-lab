#!/usr/bin/env bash
# Hpa capture policy helpers; uses the entry script configuration.
# shellcheck disable=SC2034

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
