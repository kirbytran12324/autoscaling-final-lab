#!/usr/bin/env bash
# Shared capture configuration validation and temporary-directory cleanup.

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

cleanup_work_dir() {
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    rm -f -- "$work_dir"/*
    rmdir -- "$work_dir" 2>/dev/null || true
  fi
}

on_interrupt() {
  signal_name="$1"
  if [[ "$signal_name" == "INT" ]]; then
    exit 130
  fi
  exit 143
}

capture_fingerprint() {
  local file="$1" filter="$2"
  jq -cS "$filter" "$file" | sha256sum | awk '{print $1}'
}
