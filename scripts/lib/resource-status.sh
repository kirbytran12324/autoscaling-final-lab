#!/usr/bin/env bash
# Resource capture policy helpers; uses the entry script configuration.
# shellcheck disable=SC2034

write_capture_status() {
  local exit_code="$1"
  local capture_status="failed"
  local end_timestamp
  local status_tmp

  (( capture_started == 1 )) || return 0
  (( capture_finished == 0 )) || return 0

  if [[ -f "$output_dir/simulator-throttling.csv" ]]; then
    warning_count="$(awk -F, 'NR > 1 && $NF != "ok" { count += 1 } END { print count + 0 }' \
      "$output_dir/simulator-throttling.csv")"
  fi

  end_timestamp="$(date --utc --iso-8601=seconds)"
  if (( exit_code == 0 && failed_sample_count == 0 )); then
    capture_status="complete"
  elif [[ -n "$signal_name" ]]; then
    capture_status="interrupted"
  fi

  status_tmp="$work_dir/capture-status.json"
  if ! jq -n \
    --arg schema_version "2" \
    --arg experiment_id "$experiment_id" \
    --arg status "$capture_status" \
    --arg started_at "$capture_start_timestamp" \
    --arg ended_at "$end_timestamp" \
    --arg signal "$signal_name" \
    --argjson exit_code "$exit_code" \
    --argjson samples "$sample_count" \
    --argjson failed_samples "$failed_sample_count" \
    --argjson warnings "$warning_count" \
    --arg final_validation "$final_validation_status" \
    '{
      schemaVersion: $schema_version,
      experimentId: $experiment_id,
      status: $status,
      startedAt: $started_at,
      endedAt: $ended_at,
      exitCode: $exit_code,
      sampleCount: $samples,
      failedSampleCount: $failed_samples,
      warningCount: $warnings,
      finalValidation: $final_validation,
      interruptionSignal: (if $signal == "" then null else $signal end)
    }' > "$status_tmp"; then
    printf 'error: could not create capture status\n' >&2
    return 1
  fi

  if ! mv -- "$status_tmp" "$output_dir/capture-status.json"; then
    printf 'error: could not publish capture status\n' >&2
    return 1
  fi

  capture_finished=1
  return 0
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
      printf 'Capture completed successfully: %s\n' "$output_dir"
    else
      printf 'Capture did not complete successfully (exit %d): %s\n' \
        "$exit_code" "$output_dir" >&2
    fi
  fi

  exit "$exit_code"
}
