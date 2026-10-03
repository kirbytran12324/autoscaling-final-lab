#!/usr/bin/env bash
# Resource capture policy helpers; uses the entry script configuration.
# shellcheck disable=SC2034

run_kubectl() {
  timeout "${kubectl_timeout_seconds}s" \
    kubectl --request-timeout="${kubectl_timeout_seconds}s" "$@"
}

deployment_is_settled() {
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

pod_is_settled() {
  local pods_file="$1"
  local container="$2"

  jq -e --arg container "$container" '
    (.items | length) == 1 and
    (.items[0].metadata.ownerReferences // [] | any(.kind == "ReplicaSet")) and
    .items[0].status.phase == "Running" and
    (.items[0].status.conditions // [] |
      any(.type == "Ready" and .status == "True")) and
    (.items[0].status.containerStatuses // [] |
      any(.name == $container and .ready == true and
          (.imageID // "") != "" and (.containerID // "") != ""))
  ' "$pods_file" >/dev/null
}

hpa_state_is_valid() {
  local hpa_file="$1"

  jq -e \
    --arg simulator_namespace "$simulator_namespace" \
    --arg simulator_deployment "$simulator_deployment" \
    --arg locust_namespace "$locust_namespace" \
    --arg locust_deployment "$locust_deployment" '
    [.items[] | select(
      .spec.scaleTargetRef.kind == "Deployment" and
      ((.metadata.namespace == $simulator_namespace and
        .spec.scaleTargetRef.name == $simulator_deployment) or
       (.metadata.namespace == $locust_namespace and
        .spec.scaleTargetRef.name == $locust_deployment))
    )] | length == 0
  ' "$hpa_file" >/dev/null
}

deployment_fingerprint() {
  capture_fingerprint "$1" '{uid: .metadata.uid, generation: .metadata.generation, spec: .spec}'
}

runtime_image_id() {
  local pods_file="$1"
  local container="$2"

  jq -er --arg container "$container" '
    .items[0].status.containerStatuses[] |
    select(.name == $container) | .imageID
  ' "$pods_file"
}

runtime_identity() {
  local pods_file="$1"
  local container="$2"

  jq -cerS --arg container "$container" '
    .items[0] as $pod |
    ($pod.status.containerStatuses[] | select(.name == $container)) as $status |
    {
      podUid: $pod.metadata.uid,
      containerId: $status.containerID,
      restartCount: $status.restartCount
    }
  ' "$pods_file"
}
