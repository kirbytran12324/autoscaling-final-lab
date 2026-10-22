"""Exercise stale-revision, failed-smoke and schema gates without a cluster."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import schema_validation as SCHEMAS


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VERIFY = load("verify_dev", "verify-dev-deployment.py")
CONFIG = load("verify_config", "deployment-verification-config.py")
REVISION = "a" * 40
IMAGE = "ghcr.io/kirbytran12324/metronome-simulator@sha256:" + "b" * 64


def fixtures():
    app = {
        "spec": {"source": {"repoURL": VERIFY.SOURCE_REPO, "path": "k8s/gitops/overlays/dev"},
                 "destination": {"server": "https://kubernetes.default.svc", "namespace": "metronome-dev"}},
        "status": {"sync": {"revision": REVISION, "status": "Synced"}, "health": {"status": "Healthy"},
                   "operationState": {"phase": "Succeeded", "startedAt": "2026-10-22T01:00:00Z",
                                      "finishedAt": "2026-10-22T01:01:00Z", "syncResult": {
                                          "revision": REVISION, "resources": [{"group": "batch", "kind": "Job",
                                          "namespace": "metronome-dev", "name": "metronome-dev-smoke",
                                          "hookType": "PostSync", "hookPhase": "Succeeded"}]}}},
    }
    deployment = {"metadata": {"generation": 2}, "spec": {"replicas": 1, "template": {
        "spec": {"containers": [{"image": IMAGE}]}}}, "status": {"observedGeneration": 2, "replicas": 1,
        "updatedReplicas": 1, "readyReplicas": 1, "availableReplicas": 1}}
    job = {"metadata": {"creationTimestamp": "2026-10-22T01:00:30Z", "annotations": {
        "argocd.argoproj.io/hook": "PostSync"}}, "status": {"succeeded": 1,
        "completionTime": "2026-10-22T01:00:40Z"}}
    return app, deployment, job


class DeploymentObservation(unittest.TestCase):
    def test_ready_requires_current_revision_health_and_succeeded_operation(self):
        app, _, _ = fixtures()
        self.assertTrue(VERIFY.argo_ready(app, REVISION))
        for mode in ("revision", "operation", "health", "sync", "running"):
            changed = copy.deepcopy(app)
            if mode == "revision":
                changed["status"]["sync"]["revision"] = "c" * 40
            elif mode == "operation":
                changed["status"]["operationState"]["syncResult"]["revision"] = "c" * 40
            elif mode == "health":
                changed["status"]["health"]["status"] = "Progressing"
            elif mode == "sync":
                changed["status"]["sync"]["status"] = "OutOfSync"
            else:
                changed["operation"] = {"sync": {}}
            with self.subTest(mode=mode):
                self.assertFalse(VERIFY.argo_ready(changed, REVISION))

    def test_failed_sync_missing_hook_and_destination_drift_are_rejected(self):
        for mode in ("failed", "hook", "destination", "source"):
            app, _, _ = fixtures()
            if mode == "failed":
                app["status"]["operationState"]["phase"] = "Failed"
            elif mode == "hook":
                app["status"]["operationState"]["syncResult"]["resources"] = []
            elif mode == "destination":
                app["spec"]["destination"]["namespace"] = "metronome-prod"
            else:
                app["spec"]["source"]["path"] = "k8s/azure/app"
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                VERIFY.argo_ready(app, REVISION)

    def test_workload_requires_observed_rollout_digest_and_this_sync_smoke(self):
        app, deployment, job = fixtures()
        self.assertTrue(VERIFY.workloads_ready(app, deployment, job, IMAGE))
        for key in ("observedGeneration", "updatedReplicas", "readyReplicas", "availableReplicas", "replicas"):
            changed = copy.deepcopy(deployment)
            changed["status"][key] = 0
            with self.subTest(key=key):
                self.assertFalse(VERIFY.workloads_ready(app, changed, job, IMAGE))
        for mode in ("digest", "old-job", "failed-job", "hook"):
            changed_deployment, changed_job = copy.deepcopy(deployment), copy.deepcopy(job)
            if mode == "digest":
                changed_deployment["spec"]["template"]["spec"]["containers"][0]["image"] = "simulator:latest"
            elif mode == "old-job":
                changed_job["metadata"]["creationTimestamp"] = "2026-10-21T01:00:00Z"
            elif mode == "failed-job":
                changed_job["status"]["conditions"] = [{"type": "Failed", "status": "True"}]
            else:
                changed_job["metadata"]["annotations"] = {}
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                VERIFY.workloads_ready(app, changed_deployment, changed_job, IMAGE)

    def test_observation_only_reads_explicit_context_and_rechecks_argo(self):
        app, deployment, job = fixtures()
        commands = []

        def run(arguments, **options):
            commands.append(arguments)
            if arguments[1] == "config":
                return subprocess.CompletedProcess(arguments, 0, "configured-reader")
            self.assertEqual(arguments[1:5], ["--context", "test-reader", "--request-timeout=10s", "-n"])
            self.assertIn("get", arguments)
            value = app if "application" in arguments else deployment if "deployment" in arguments else job
            return subprocess.CompletedProcess(arguments, 0, json.dumps(value))

        VERIFY.observe("test-reader", REVISION, IMAGE, run=run)
        self.assertEqual(sum("application" in command for command in commands), 2)

    def test_invalid_arguments_never_invoke_kubectl(self):
        for context, revision, image in (("", REVISION, IMAGE), ("--context", REVISION, IMAGE),
                                          ("reader", "main", IMAGE), ("reader", REVISION, "simulator:latest")):
            with self.subTest(context=context, revision=revision), self.assertRaises(ValueError):
                VERIFY.observe(context, revision, image, run=lambda *args, **kwargs: self.fail("tool invoked"))

    def test_concurrent_sync_does_not_combine_two_operations(self):
        app, deployment, job = fixtures()
        newer = copy.deepcopy(app)
        newer["status"]["operationState"]["startedAt"] = "2026-10-22T01:00:01Z"
        responses = iter([app, deployment, job, newer])
        ticks = iter([0, 2])

        def run(arguments, **options):
            value = "reader" if arguments[1] == "config" else json.dumps(next(responses))
            return subprocess.CompletedProcess(arguments, 0, value)

        with self.assertRaises(TimeoutError):
            VERIFY.observe("reader", REVISION, IMAGE, timeout=1, run=run,
                           monotonic=lambda: next(ticks), sleep=lambda _: self.fail("unexpected sleep"))

    def test_pending_revision_times_out_and_missing_context_fails_early(self):
        app, _, _ = fixtures()
        app["status"]["sync"]["revision"] = "c" * 40
        ticks = iter([0, 2])

        def run(arguments, **options):
            value = "reader" if arguments[1] == "config" else json.dumps(app)
            return subprocess.CompletedProcess(arguments, 0, value)

        with self.assertRaises(TimeoutError):
            VERIFY.observe("reader", REVISION, IMAGE, timeout=1, run=run,
                           monotonic=lambda: next(ticks), sleep=lambda _: self.fail("unexpected sleep"))
        with self.assertRaises(ValueError):
            VERIFY.observe("reader", REVISION, IMAGE,
                           run=lambda arguments, **options: subprocess.CompletedProcess(arguments, 0, ""))

    def test_missing_runner_configuration_fails_before_scheduling(self):
        values = {"RUNNER_READY": "true", "DEV_VERIFY_RUNNER": "metronome-local-reader",
                  "DEV_VERIFY_CONTEXT": "docker-desktop-reader", "PROMOTED_REVISION": REVISION}
        self.assertEqual(json.loads(CONFIG.configuration(values)), ["self-hosted", "metronome-local-reader"])
        for key in values:
            changed = {**values, key: ""}
            with self.subTest(key=key), self.assertRaises(ValueError):
                CONFIG.configuration(changed)
        with self.assertRaises(ValueError):
            CONFIG.configuration({**values, "DEV_VERIFY_RUNNER": "self-hosted"})


class SchemaGates(unittest.TestCase):
    def test_only_reviewed_custom_gvks_are_exempt(self):
        def item(api, kind):
            return {"apiVersion": api, "kind": kind, "metadata": {"name": "test"}}
        unknown = item("argoproj.io/v99", "Application")
        known = item("argoproj.io/v1alpha1", "Application")
        core, exceptions = SCHEMAS.schema_objects([unknown, known, item("apps/v1", "Deployment")])
        self.assertEqual(core[0], unknown)
        self.assertEqual(len(core), 2)
        self.assertEqual(exceptions, [(("argoproj.io/v1alpha1", "Application"), "test")])

    def test_validator_pins_strict_schema_and_rejects_tool_version_drift(self):
        calls = []

        def run(arguments, **kwargs):
            calls.append(arguments)
            return subprocess.CompletedProcess(arguments, 0, SCHEMAS.KUBECONFORM_VERSION)

        SCHEMAS.validate_schemas([], run=run)
        self.assertIn("-strict", calls[1])
        self.assertIn(SCHEMAS.SCHEMA_LOCATION, calls[1])
        self.assertNotIn("-ignore-missing-schemas", calls[1])
        with self.assertRaises(ValueError):
            SCHEMAS.validate_schemas([], run=lambda *args, **kwargs: subprocess.CompletedProcess([], 0, "wrong"))

    @unittest.skipUnless((ROOT / ".validation/tools" / ("kubeconform.exe" if os.name == "nt" else "kubeconform")).exists(),
                         "Install the pinned kubeconform binary to exercise real schema rejection")
    def test_real_validator_rejects_unknown_fields_types_and_missing_schemas(self):
        base = {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "schema-test"}}
        SCHEMAS.validate_schemas([base])
        for item in ({**base, "unexpectedField": True}, {**base, "metadata": "invalid"},
                     {**base, "apiVersion": "unknown.example/v1", "kind": "UnknownKind"}):
            with self.subTest(item=item), self.assertRaises(subprocess.CalledProcessError):
                SCHEMAS.validate_schemas([item])


if __name__ == "__main__":
    unittest.main()
