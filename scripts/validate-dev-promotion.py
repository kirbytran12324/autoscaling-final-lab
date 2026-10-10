"""Check the rendered development Deployment and PostSync smoke contract."""
import importlib.util
import json
from pathlib import Path
import subprocess

import yaml

SPEC = importlib.util.spec_from_file_location("promotion", Path(__file__).with_name("prepare-dev-promotion.py"))
PROMOTION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROMOTION)


def verify(objects, reference):
    identities = [(item["kind"], item["metadata"]["name"]) for item in objects]
    if len(identities) != len(set(identities)):
        raise ValueError("Duplicate development resources")
    allowed = {"Namespace", "ConfigMap", "Service", "Deployment", "Job"}
    for item in objects:
        if item["kind"] not in allowed:
            raise ValueError(f"Unexpected development resource: {item['kind']}")
        if item["kind"] == "Namespace":
            if item["metadata"]["name"] != "metronome-dev":
                raise ValueError("Unexpected namespace")
        elif item["metadata"].get("namespace") != "metronome-dev":
            raise ValueError("Resource outside development namespace")
    workloads = [item for item in objects if item["kind"] in {"Deployment", "Job"}]
    if {(item["kind"], item["metadata"]["name"]) for item in workloads} != {
            ("Deployment", "metronome-simulator"), ("Job", "metronome-dev-smoke")}:
        raise ValueError("Expected only the simulator and smoke workload")
    for workload in workloads:
        containers = workload["spec"]["template"]["spec"]["containers"]
        if len(containers) != 1 or containers[0]["image"] != reference:
            raise ValueError("Workload image does not match the recorded simulator digest")
    smoke = next(item for item in workloads if item["kind"] == "Job")
    annotations = smoke["metadata"].get("annotations", {})
    if annotations.get("argocd.argoproj.io/hook") != "PostSync" or annotations.get("argocd.argoproj.io/hook-delete-policy") != "BeforeHookCreation":
        raise ValueError("Expected a PostSync hook with retained results")
    pod = smoke["spec"]["template"]["spec"]
    if pod.get("volumes") or pod.get("automountServiceAccountToken") is not False or pod.get("restartPolicy") != "Never":
        raise ValueError("Smoke Job must not mount data or Kubernetes credentials")
    if smoke["spec"].get("backoffLimit") != 0 or smoke["spec"].get("activeDeadlineSeconds") != 120:
        raise ValueError("Smoke Job retry/deadline contract changed")


def main():
    try:
        selection = json.loads(PROMOTION.SELECTION.read_text(encoding="utf-8"), object_pairs_hook=PROMOTION.unique_keys)
        if selection.get("schemaVersion") != 1 or selection.get("environment") != "metronome-dev":
            raise ValueError("Unexpected selection record")
        release = selection["release"]
        run = release["workflowRun"].rsplit("/", 1)[-1]
        reference = PROMOTION.validate_release(release, release["commit"], run, release["workflowAttempt"])
        rendered = subprocess.run(["kubectl", "kustomize", str(PROMOTION.DEV.parent)], check=True, capture_output=True, text=True)
        verify([item for item in yaml.safe_load_all(rendered.stdout) if item], reference)
        print("Validated development digest, namespace, workloads and PostSync smoke contract.")
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError, yaml.YAMLError) as error:
        raise SystemExit(f"Development validation failed: {error}") from error


if __name__ == "__main__":
    main()
