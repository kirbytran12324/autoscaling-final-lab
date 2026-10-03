#!/usr/bin/env bash
# Hpa capture policy helpers; uses the entry script configuration.
# shellcheck disable=SC2034

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
  capture_fingerprint "$1" '{uid: .metadata.uid, spec: (.spec | del(.replicas))}'
}

object_spec_fingerprint_for() {
  capture_fingerprint "$1" '{uid: .metadata.uid, spec: .spec}'
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
