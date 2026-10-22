"""Fail before scheduling a private runner unless observation was configured deliberately."""
import json
import os
import re
import subprocess


def configuration(values):
    if values.get("RUNNER_READY") != "true":
        raise ValueError("Confirm the dedicated read-only runner is online before dispatching verification")
    label, context, revision = (values.get(key, "") for key in
                                ("DEV_VERIFY_RUNNER", "DEV_VERIFY_CONTEXT", "PROMOTED_REVISION"))
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,62}", label) or label.lower() in {
            "self-hosted", "linux", "windows", "macos", "x64", "arm64"}:
        raise ValueError("Set DEV_VERIFY_RUNNER to a dedicated runner label (not a generic platform label)")
    if not context or context.startswith("-") or any(character.isspace() for character in context):
        raise ValueError("Set DEV_VERIFY_CONTEXT to the preconfigured read-only Kubernetes context")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Supply the full promoted desired-state Git SHA")
    return json.dumps(["self-hosted", label])


if __name__ == "__main__":
    try:
        labels = configuration(os.environ)
        # The hosted preflight checkout has main history, and never uses cluster credentials.
        subprocess.run(["git", "merge-base", "--is-ancestor", os.environ["PROMOTED_REVISION"], "origin/main"], check=True)
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write(f"runner={labels}\n")
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"Deployment observation is not configured: {error}") from error
