"""Observe an exact Argo revision, simulator rollout and its successful PostSync smoke.

Only explicit-context kubectl get/config operations are used. This never syncs,
applies, rolls back, changes contexts, or bootstraps authentication.
"""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
SOURCE_REPO = "https://github.com/kirbytran12324/autoscaling-final-lab.git"
IMAGE = re.compile(r"ghcr\.io/kirbytran12324/metronome-simulator@sha256:[0-9a-f]{64}")


def argument_values(context, revision, image):
    if not context or context.startswith("-") or any(character.isspace() for character in context):
        raise ValueError("Supply an explicit Kubernetes context name without whitespace")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Revision must be the full promoted Git commit SHA")
    if not IMAGE.fullmatch(image):
        raise ValueError("Expected the selected simulator repository and immutable sha256 digest")


def argo_ready(app, revision):
    spec, status = app.get("spec", {}), app.get("status", {})
    if (spec.get("source", {}).get("repoURL") != SOURCE_REPO or
            spec.get("source", {}).get("path") != "k8s/gitops/overlays/dev" or
            spec.get("destination") != {"server": "https://kubernetes.default.svc", "namespace": "metronome-dev"}):
        raise ValueError("Argo Application source or destination differs from the reviewed local development contract")
    operation = status.get("operationState", {})
    result = operation.get("syncResult", {})
    if result.get("revision") == revision and operation.get("phase") in {"Failed", "Error"}:
        raise ValueError("Argo sync failed for the requested revision")
    if (status.get("sync", {}).get("revision") != revision or
            status.get("sync", {}).get("status") != "Synced" or
            status.get("health", {}).get("status") != "Healthy" or
            result.get("revision") != revision or operation.get("phase") != "Succeeded" or app.get("operation")):
        return False
    smoke = [resource for resource in result.get("resources", []) if
             resource.get("group") == "batch" and resource.get("kind") == "Job" and resource.get("namespace") == "metronome-dev" and
             resource.get("name") == "metronome-dev-smoke" and resource.get("hookType") == "PostSync"]
    if len(smoke) != 1 or smoke[0].get("hookPhase") != "Succeeded":
        raise ValueError("The requested sync lacks a successful PostSync smoke result")
    return True


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("A timezone is required")
        return parsed
    except (AttributeError, TypeError, ValueError) as error:
        raise ValueError("Missing or malformed sync/smoke timestamp") from error


def workloads_ready(app, deployment, job, image):
    spec, status = deployment.get("spec", {}), deployment.get("status", {})
    containers = spec.get("template", {}).get("spec", {}).get("containers", [])
    if len(containers) != 1 or containers[0].get("image") != image:
        raise ValueError("Live simulator Deployment image differs from the selected release digest")
    desired = spec.get("replicas", 1)
    if (desired < 1 or status.get("observedGeneration", 0) < deployment["metadata"]["generation"] or
            any(status.get(key, 0) != desired for key in ("updatedReplicas", "readyReplicas", "availableReplicas")) or
            status.get("replicas", 0) != desired):
        return False
    if any(condition.get("type") == "Failed" and condition.get("status") == "True"
           for condition in job.get("status", {}).get("conditions", [])):
        raise ValueError("PostSync smoke Job failed")
    if job.get("status", {}).get("succeeded") != 1:
        return False
    if job.get("metadata", {}).get("annotations", {}).get("argocd.argoproj.io/hook") != "PostSync":
        raise ValueError("Smoke Job is not a PostSync hook")
    operation = app["status"]["operationState"]
    started, finished = timestamp(operation.get("startedAt")), timestamp(operation.get("finishedAt"))
    created, completed = timestamp(job["metadata"].get("creationTimestamp")), timestamp(job["status"].get("completionTime"))
    if not started <= created <= completed <= finished:
        raise ValueError("Smoke Job is stale or does not belong to this sync's time window")
    return True


def observe(context, revision, image, timeout=300, interval=5, run=subprocess.run,
            monotonic=time.monotonic, sleep=time.sleep):
    argument_values(context, revision, image)
    if not 1 <= timeout <= 900 or not 1 <= interval <= 30:
        raise ValueError("Timeout must be 1-900 seconds and interval 1-30 seconds")

    def kubectl(*arguments):
        result = run(["kubectl", "--context", context, "--request-timeout=10s", *arguments],
                     check=True, capture_output=True, text=True, timeout=15)
        return json.loads(result.stdout)

    # Refuse a typo before polling. Reading config never changes current-context.
    configured = run(["kubectl", "config", "get-contexts", context, "--no-headers"],
                     check=True, capture_output=True, text=True, timeout=15)
    if not configured.stdout.strip():
        raise ValueError("The selected Kubernetes context is not configured on this runner")
    deadline = monotonic() + timeout
    while True:
        app = kubectl("-n", "argocd", "get", "application", "metronome-dev", "-o", "json")
        if argo_ready(app, revision):
            deployment = kubectl("-n", "metronome-dev", "get", "deployment", "metronome-simulator", "-o", "json")
            job = kubectl("-n", "metronome-dev", "get", "job", "metronome-dev-smoke", "-o", "json")
            if workloads_ready(app, deployment, job, image):
                # Do not combine a previous operation with status from a newer sync.
                latest = kubectl("-n", "argocd", "get", "application", "metronome-dev", "-o", "json")
                if argo_ready(latest, revision) and latest["status"]["operationState"] == app["status"]["operationState"]:
                    return
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise TimeoutError("Timed out waiting for the exact revision, Healthy rollout and PostSync smoke")
        sleep(min(interval, remaining))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", default=os.environ.get("DEV_VERIFY_CONTEXT"))
    parser.add_argument("--revision", default=os.environ.get("PROMOTED_REVISION"),
                        help="Desired-state promotion commit, not the image source commit")
    parser.add_argument("--selection", type=Path, default=os.environ.get("DEV_VERIFY_SELECTION") or
                        ROOT / "k8s/gitops/overlays/dev/release-selection.json")
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    if not args.context or not args.revision:
        parser.error("--context and --revision (or their workflow environment values) are required")
    try:
        selection = json.loads(args.selection.read_text(encoding="utf-8"))
        if selection.get("schemaVersion") != 1 or selection.get("environment") != "metronome-dev":
            raise ValueError("Expected the development release-selection record from the promoted checkout")
        image = selection["release"]["images"]["simulator"]
        observe(args.context, args.revision, image, args.timeout)
        print(f"Verified development revision {args.revision}, image {image}, Healthy rollout and PostSync smoke.")
    except (OSError, ValueError, KeyError, TimeoutError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Deployment verification failed: {error}\n")


if __name__ == "__main__":
    main()
