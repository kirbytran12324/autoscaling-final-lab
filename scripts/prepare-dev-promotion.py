"""Validate a release and preview its simulator digest in the dev overlay."""
import argparse
import copy
import difflib
import json
import os
from pathlib import Path
import re
import tempfile

import yaml

ROOT = Path(__file__).resolve().parents[1]
DEV = ROOT / "k8s/gitops/overlays/dev/kustomization.yaml"
SELECTION = DEV.with_name("release-selection.json")
REPOSITORY = "kirbytran12324/autoscaling-final-lab"
IMAGE_NAMES = {"simulator", "explorer-api", "explorer-web", "control-api", "load-test"}


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def validate_release(record, commit, run, attempt):
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Expected commit must be a full lowercase Git SHA")
    if not re.fullmatch(r"[1-9][0-9]*", run) or not re.fullmatch(r"[1-9][0-9]*", attempt):
        raise ValueError("Expected run and attempt must be positive integers")
    if not isinstance(record, dict) or type(record.get("schemaVersion")) is not int or record["schemaVersion"] != 1:
        raise ValueError("Unsupported release schema")
    expected_url = f"https://github.com/{REPOSITORY}/actions/runs/{run}"
    if (record.get("commit"), record.get("workflowRun"), record.get("workflowAttempt")) != (commit, expected_url, attempt):
        raise ValueError("Release commit, workflow run or attempt does not match expectations")
    images = record.get("images")
    if not isinstance(images, dict) or set(images) != IMAGE_NAMES:
        raise ValueError("Release must contain exactly the five expected images")
    for name, reference in images.items():
        prefix = f"ghcr.io/kirbytran12324/metronome-{name}@sha256:"
        if not isinstance(reference, str) or not re.fullmatch(re.escape(prefix) + r"[0-9a-f]{64}", reference):
            raise ValueError(f"Unexpected repository or invalid digest for {name}")
    return images["simulator"]


def prepare_overlay(source, reference):
    document = yaml.safe_load(source)
    if not isinstance(document, dict) or document.get("kind") != "Kustomization" or document.get("namespace") != "metronome-dev":
        raise ValueError("Expected the metronome-dev Kustomization")
    images = document.get("images")
    if not isinstance(images, list) or len(images) != 1 or not isinstance(images[0], dict) or images[0].get("name") != "metronome-simulator":
        raise ValueError("Expected exactly one simulator image override; review any overlay expansion first")
    repository, digest = reference.split("@")
    expected = copy.deepcopy(document)
    expected["images"] = [{"name": "metronome-simulator", "newName": repository, "digest": digest}]
    resources = expected.get("resources")
    if not isinstance(resources, list):
        raise ValueError("Expected an explicit development resource list")
    hook = "../../checks"
    if hook not in resources:
        resources.append(hook)
    # Preserve formatting outside the image block in this small, known overlay.
    block = re.compile(r"^images:\n(?:[ \t]+[^\n]*\n|[ \t]*\n)+", re.MULTILINE)
    replacement = f"images:\n  - name: metronome-simulator\n    newName: {repository}\n    digest: {digest}\n\n"
    candidate, count = block.subn(replacement, source)
    if hook not in document["resources"]:
        resource_block = re.compile(r"^resources:\n(?:[ \t]+[^\n]*\n)+", re.MULTILINE)
        candidate, resource_count = resource_block.subn(lambda match: match.group() + f"  - {hook}\n", candidate)
        if resource_count != 1:
            raise ValueError("Resource layout changed; refusing an ambiguous edit")
    if count != 1 or yaml.safe_load(candidate) != expected:
        raise ValueError("Overlay layout changed; refusing an ambiguous edit")
    return candidate


def atomic_write(path, content):
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=path.parent, delete=False) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(content)
        os.replace(temporary_path, path)
    finally:
        if temporary_path:
            temporary_path.unlink(missing_ok=True)


def selection_record(source, record, previous):
    image = yaml.safe_load(source)["images"][0]
    repository = image.get("newName", image["name"])
    reference = f"{repository}@{image['digest']}" if image.get("digest") else f"{repository}:{image.get('newTag', '')}"
    return {"schemaVersion": 1, "environment": "metronome-dev", "release": record,
            "previous": {"image": reference, "release": previous.get("release")}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release", type=Path)
    parser.add_argument("--expected-commit", required=True)
    parser.add_argument("--expected-run", required=True)
    parser.add_argument("--expected-attempt", required=True)
    parser.add_argument("--write", action="store_true", help="Write only the local dev Kustomization")
    parser.add_argument("--record", action="store_true", help="Also record the release and previous selection for CI")
    args = parser.parse_args()
    try:
        if args.record and not args.write:
            raise ValueError("--record requires --write")
        record = json.loads(args.release.read_text(encoding="utf-8"), object_pairs_hook=unique_keys)
        reference = validate_release(record, args.expected_commit, args.expected_run, args.expected_attempt)
        source = DEV.read_text(encoding="utf-8")
        candidate = prepare_overlay(source, reference)
        print(f"Validated release: {record['commit']} (run {args.expected_run}, attempt {args.expected_attempt})")
        print(f"Dev simulator: {reference}")
        previous = json.loads(SELECTION.read_text(encoding="utf-8"), object_pairs_hook=unique_keys) if args.record and SELECTION.exists() else {}
        if not isinstance(previous, dict):
            raise ValueError("Invalid previous selection record")
        audit = selection_record(source, record, previous) if args.record else None
        if candidate == source and (not args.record or previous.get("release") == record):
            print("Already selected; no change.")
            return
        print("".join(difflib.unified_diff(source.splitlines(True), candidate.splitlines(True), fromfile=str(DEV), tofile=str(DEV))), end="")
        if args.write:
            atomic_write(DEV, candidate)
            if audit:
                atomic_write(SELECTION, json.dumps(audit, indent=2) + "\n")
            print("Updated the local dev Kustomization. Review and render before committing.")
        else:
            print("Preview only. Add --write to update the local file.")
    except (OSError, ValueError, yaml.YAMLError) as error:
        parser.exit(1, f"Promotion refused: {error}\n")


if __name__ == "__main__":
    main()
