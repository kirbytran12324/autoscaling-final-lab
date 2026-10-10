"""Offline safety checks for release validation and development-only updates."""
import copy
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

import yaml

SPEC = importlib.util.spec_from_file_location("promotion", Path(__file__).with_name("prepare-dev-promotion.py"))
PROMOTION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROMOTION)
VERIFY_SPEC = importlib.util.spec_from_file_location("verify_promotion", Path(__file__).with_name("validate-dev-promotion.py"))
VERIFY = importlib.util.module_from_spec(VERIFY_SPEC)
VERIFY_SPEC.loader.exec_module(VERIFY)
COMMIT = "a" * 40
RELEASE = {
    "schemaVersion": 1,
    "commit": COMMIT,
    "workflowRun": f"https://github.com/{PROMOTION.REPOSITORY}/actions/runs/123",
    "workflowAttempt": "1",
    "images": {name: f"ghcr.io/kirbytran12324/metronome-{name}@sha256:{'b' * 64}" for name in PROMOTION.IMAGE_NAMES},
}
SOURCE = "kind: Kustomization\nnamespace: metronome-dev\nimages:\n  - name: metronome-simulator\n    newTag: old\n\nresources:\n  - ../../common\n"


class PromotionTests(unittest.TestCase):
    def test_workflow_guard_and_normal_push_reject_concurrent_main_change(self):
        workflow = yaml.safe_load((PROMOTION.ROOT / ".github/workflows/release.yaml").read_text(encoding="utf-8"))
        job = workflow["jobs"]["promote-dev"]
        guard = next(step["run"] for step in job["steps"] if step.get("id") == "current")
        publish = next(step["run"] for step in job["steps"] if step.get("name") == "Commit and publish development desired state")
        bash = shutil.which("bash") if os.name != "nt" else str(Path(shutil.which("git")).resolve().parents[1] / "bin/bash.exe")
        with tempfile.TemporaryDirectory(prefix="promotion-git-test-") as directory:
            root = Path(directory).resolve()
            remote, source, actor = [root / name for name in ("remote.git", "source", "actor")]

            def git(cwd, *args):
                return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()

            git(root, "init", "--bare", str(remote))
            git(root, "init", "-b", "main", str(source))
            git(source, "config", "user.name", "Local safety test")
            git(source, "config", "user.email", "test@example.invalid")
            (source / "source.txt").write_text("release", encoding="utf-8")
            git(source, "add", "source.txt")
            git(source, "commit", "-m", "source release")
            release_commit = git(source, "rev-parse", "HEAD")
            git(source, "remote", "add", "origin", str(remote))
            git(source, "push", "origin", "main")
            git(root, "clone", "--branch", "main", str(remote), str(actor))
            env = {**os.environ, "GITHUB_SHA": release_commit, "GITHUB_OUTPUT": "guard-output.txt", "GITHUB_STEP_SUMMARY": "summary.txt"}
            subprocess.run([bash, "-e", "-c", guard], cwd=actor, env=env, check=True, capture_output=True, text=True)
            self.assertEqual((actor / "guard-output.txt").read_text().strip(), "eligible=true")
            # Advance the remote after the guard succeeds, before the actual push.
            (source / "source.txt").write_text("newer source", encoding="utf-8")
            git(source, "commit", "-am", "newer source")
            git(source, "push", "origin", "main")
            newer_commit = git(source, "rev-parse", "HEAD")
            dev = actor / "k8s/gitops/overlays/dev"
            dev.mkdir(parents=True)
            (dev / "kustomization.yaml").write_text("local test promotion", encoding="utf-8")
            (dev / "release-selection.json").write_text("{}", encoding="utf-8")
            rejected = subprocess.run([bash, "-e", "-c", publish], cwd=actor, env=env, capture_output=True, text=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(git(remote, "rev-parse", "refs/heads/main"), newer_commit)
            subprocess.run([bash, "-e", "-c", guard], cwd=actor, env=env, check=True, capture_output=True, text=True)
            self.assertTrue((actor / "guard-output.txt").read_text().strip().endswith("eligible=false"))

    def test_preview_write_and_rejection_leave_expected_files(self):
        with tempfile.TemporaryDirectory(prefix="dev-promotion-test-") as directory:
            target = Path(directory) / "kustomization.yaml"
            record = Path(directory) / "release.json"
            target.write_text(SOURCE, encoding="utf-8")
            record.write_text(json.dumps(RELEASE), encoding="utf-8")
            argv = ["prepare-dev-promotion.py", str(record), "--expected-commit", COMMIT, "--expected-run", "123", "--expected-attempt", "1"]
            selection_path = Path(directory) / "release-selection.json"
            with patch.object(PROMOTION, "DEV", target), patch.object(PROMOTION, "SELECTION", selection_path), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                with patch("sys.argv", argv):
                    PROMOTION.main()
                self.assertEqual(target.read_text(encoding="utf-8"), SOURCE)
                with patch("sys.argv", argv + ["--write", "--record"]):
                    PROMOTION.main()
                expected = PROMOTION.prepare_overlay(SOURCE, RELEASE["images"]["simulator"])
                self.assertEqual(target.read_text(encoding="utf-8"), expected)
                audit_bytes = selection_path.read_bytes()
                with patch("sys.argv", argv + ["--write", "--record"]):
                    PROMOTION.main()
                self.assertEqual(selection_path.read_bytes(), audit_bytes)
                record.write_text(json.dumps({**RELEASE, "commit": "c" * 40}), encoding="utf-8")
                with patch("sys.argv", argv + ["--write"]), self.assertRaises(SystemExit) as failure:
                    PROMOTION.main()
                self.assertEqual(failure.exception.code, 1)
                self.assertEqual(target.read_text(encoding="utf-8"), expected)

    def test_rendered_candidate_and_reject_digest_or_namespace_drift(self):
        with tempfile.TemporaryDirectory(prefix="promotion-render-") as directory:
            root = Path(directory).resolve()
            for relative in ("k8s/base", "k8s/gitops/common", "k8s/gitops/checks", "k8s/gitops/overlays/dev"):
                target = (root / relative).resolve()
                self.assertTrue(target.is_relative_to(root))
                shutil.copytree(PROMOTION.ROOT / relative, target)
            dev = root / "k8s/gitops/overlays/dev"
            source = (dev / "kustomization.yaml").read_text(encoding="utf-8")
            reference = RELEASE["images"]["simulator"]
            (dev / "kustomization.yaml").write_text(PROMOTION.prepare_overlay(source, reference), encoding="utf-8")
            rendered = subprocess.run(["kubectl", "kustomize", str(dev)], check=True, capture_output=True, text=True).stdout
            objects = list(yaml.safe_load_all(rendered))
            VERIFY.verify(objects, reference)
            for mode in ("image", "namespace", "volume", "hook"):
                changed = copy.deepcopy(objects)
                job = next(item for item in changed if item["kind"] == "Job")
                if mode == "image":
                    job["spec"]["template"]["spec"]["containers"][0]["image"] = "unexpected:latest"
                elif mode == "namespace":
                    job["metadata"]["namespace"] = "metronome-prod"
                elif mode == "volume":
                    job["spec"]["template"]["spec"]["volumes"] = [{"name": "data"}]
                else:
                    job["metadata"]["annotations"]["argocd.argoproj.io/hook"] = "PreSync"
                with self.subTest(mode=mode), self.assertRaises(ValueError):
                    VERIFY.verify(changed, reference)

    def test_smoke_requires_both_http_endpoints(self):
        job = yaml.safe_load((PROMOTION.ROOT / "k8s/gitops/checks/dev-smoke.yaml").read_text(encoding="utf-8"))
        script = job["spec"]["template"]["spec"]["containers"][0]["args"][0]
        for failing_path in (None, "/health/live", "/health/ready"):
            requested = []

            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    requested.append(self.path)
                    self.send_response(503 if self.path == failing_path else 200)
                    self.end_headers()

                def log_message(self, *args):
                    pass

            with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    env = {**os.environ, "SMOKE_BASE_URL": f"http://127.0.0.1:{server.server_port}"}
                    result = subprocess.run(["node", "-e", script], env=env, capture_output=True, text=True, timeout=15)
                    self.assertEqual(result.returncode, 1 if failing_path else 0)
                    if not failing_path:
                        self.assertEqual(requested, ["/health/live", "/health/ready"])
                finally:
                    server.shutdown()
                    thread.join()

    def test_valid_release_and_idempotent_overlay(self):
        reference = PROMOTION.validate_release(RELEASE, COMMIT, "123", "1")
        candidate = PROMOTION.prepare_overlay(SOURCE, reference)
        self.assertEqual(PROMOTION.prepare_overlay(candidate, reference), candidate)
        before, after = yaml.safe_load(SOURCE), yaml.safe_load(candidate)
        before.pop("images")
        image = after.pop("images")[0]
        self.assertEqual(after["resources"], before["resources"] + ["../../checks"])
        after["resources"] = before["resources"]
        self.assertEqual(before, after)
        self.assertNotIn("newTag", image)
        self.assertEqual(f"{image['newName']}@{image['digest']}", reference)

    def test_selection_keeps_previous_image_and_release(self):
        selection = PROMOTION.selection_record(SOURCE, RELEASE, {})
        self.assertEqual(selection["previous"]["image"], "metronome-simulator:old")
        self.assertIsNone(selection["previous"]["release"])
        previous = {**RELEASE, "commit": "c" * 40}
        selection = PROMOTION.selection_record(SOURCE, RELEASE, {"release": previous})
        self.assertEqual(selection["previous"]["release"], previous)
        self.assertEqual(selection["release"], RELEASE)

    def test_reject_inconsistent_metadata(self):
        for key, value in [("schemaVersion", True), ("commit", "c" * 40), ("workflowRun", "https://github.com/other/repo/actions/runs/123"), ("workflowAttempt", "2")]:
            with self.subTest(key=key):
                record = copy.deepcopy(RELEASE)
                record[key] = value
                with self.assertRaises(ValueError):
                    PROMOTION.validate_release(record, COMMIT, "123", "1")

    def test_reject_missing_extra_and_invalid_images(self):
        for mode in ("missing", "extra", "tag", "repository", "digest", "type"):
            with self.subTest(mode=mode):
                record = copy.deepcopy(RELEASE)
                images = record["images"]
                if mode == "missing":
                    images.pop("control-api")
                elif mode == "extra":
                    images["other"] = images["simulator"]
                else:
                    images["control-api"] = {"tag": "ghcr.io/kirbytran12324/metronome-control-api:latest", "repository": images["simulator"], "digest": images["control-api"][:-1], "type": None}[mode]
                with self.assertRaises(ValueError):
                    PROMOTION.validate_release(record, COMMIT, "123", "1")

    def test_reject_duplicate_json_keys(self):
        with self.assertRaises(ValueError):
            json.loads('{"commit":"a","commit":"b"}', object_pairs_hook=PROMOTION.unique_keys)

    def test_reject_unexpected_overlay(self):
        reference = RELEASE["images"]["simulator"]
        for source in (SOURCE.replace("metronome-dev", "metronome-prod"), SOURCE.replace("metronome-simulator", "another-app"), SOURCE + "images:\n  - name: metronome-simulator\n    newTag: other\n", SOURCE.replace("images:\n", "images: # changed layout\n")):
            with self.subTest(source=source):
                with self.assertRaises(ValueError):
                    PROMOTION.prepare_overlay(source, reference)


if __name__ == "__main__":
    unittest.main()
