"""Render every Kustomization and verify the Azure workload boundaries offline."""
from pathlib import Path
import subprocess

import yaml

ROOT = Path(__file__).resolve().parents[1]


def render(directory):
    output = subprocess.run(
        ["kubectl", "kustomize", str(directory)], check=True,
        capture_output=True, text=True, encoding="utf-8",
    ).stdout
    objects = [obj for obj in yaml.safe_load_all(output) if obj]
    identities = [(obj["apiVersion"], obj["kind"],
                   obj["metadata"].get("namespace"), obj["metadata"]["name"])
                  for obj in objects]
    assert len(identities) == len(set(identities)), f"duplicate resources in {directory}"
    return objects


def validate_azure(directory, objects):
    for obj in objects:
        if obj["kind"] != "Namespace":
            assert obj["metadata"].get("namespace") == "metronome-azure"
        pod = obj.get("spec", {}) if obj["kind"] == "Pod" else (
            obj.get("spec", {}).get("template", {}).get("spec"))
        if pod and "containers" in pod:
            assert pod.get("automountServiceAccountToken") is False
            for container in pod["containers"]:
                assert container["image"].startswith("metronomelab.azurecr.io/")
                security = container["securityContext"]
                assert security["readOnlyRootFilesystem"] is True
                assert security["allowPrivilegeEscalation"] is False
                assert "ALL" in security["capabilities"]["drop"]
        if obj["kind"] == "Service":
            assert obj["spec"].get("type", "ClusterIP") == "ClusterIP"

    by_name = {(obj["kind"], obj["metadata"]["name"]): obj for obj in objects}
    if directory.name == "app":
        simulator = by_name[("Deployment", "metronome-simulator")]
        assert "replicas" not in simulator["spec"], "GitOps must not reset HPA replicas"
        hpa = by_name[("HorizontalPodAutoscaler", "metronome-simulator")]
        assert hpa["spec"]["scaleTargetRef"]["name"] == "metronome-simulator"
        assert not any(obj["kind"] == "Job" for obj in objects), "runner must be opt-in"
        archive = by_name[("PersistentVolumeClaim", "tournament-archive")]
        assert archive["spec"]["accessModes"] == ["ReadWriteMany"]
        api = by_name[("Deployment", "metronome-explorer-api")]
        pod = api["spec"]["template"]["spec"]
        env = {item["name"]: item["value"] for item in pod["containers"][0]["env"]}
        assert env["SIMULATOR_BASE_URL"] == "http://metronome-simulator"
        assert pod["containers"][0]["volumeMounts"][0]["readOnly"] is True
        assert pod["volumes"][0]["persistentVolumeClaim"]["readOnly"] is True
    if directory.name == "runner":
        job = by_name[("Job", "tournament-runner")]
        assert job["spec"]["parallelism"] == job["spec"]["completions"] == 1
        assert job["spec"]["podReplacementPolicy"] == "Failed"
        container = job["spec"]["template"]["spec"]["containers"][0]
        env = {item["name"]: item["value"] for item in container["env"]}
        assert env["SIMULATOR_IMAGE"] == container["image"], "image provenance mismatch"
        assert env["TOURNAMENT_RUN_ID"] == "azure-sample-001"
        state = by_name[("PersistentVolumeClaim", "tournament-state")]
        assert state["spec"]["accessModes"] == ["ReadWriteOncePod"]
    if directory.name == "load-test":
        container = by_name[("Deployment", "metronome-load-test")]["spec"]["template"]["spec"]["containers"][0]
        env = {item["name"]: item["value"] for item in container["env"]}
        assert env["LOCUST_HOST"] == "http://metronome-simulator"


def main():
    count = 0
    for source in sorted((ROOT / "k8s").rglob("kustomization.yaml")):
        directory = source.parent
        objects = render(directory)
        if directory.is_relative_to(ROOT / "k8s" / "azure"):
            validate_azure(directory, objects)
        count += 1
        print(f"OK {directory.relative_to(ROOT)} ({len(objects)} resources)")
    print(f"Validated {count} Kustomizations; cluster API validation is still required before deployment.")


if __name__ == "__main__":
    main()
