"""Strict Kubernetes schema checks with explicit, reviewable CRD exceptions."""
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
KUBECONFORM_VERSION = "v0.7.0"
KUBERNETES_VERSION = "1.35.0"
SCHEMA_COMMIT = "b2ba4defe30ed5a0104987433896f1fd32807304"
SCHEMA_LOCATION = (
    f"https://raw.githubusercontent.com/yannh/kubernetes-json-schema/{SCHEMA_COMMIT}/"
    "{{.NormalizedKubernetesVersion}}-standalone-strict/{{.ResourceKind}}{{.KindSuffix}}.json"
)
# These controller-owned APIs are not in Kubernetes core schemas. Each exception
# requires live admission validation against its installed controller before use.
# Unknown kinds/versions are NOT skipped. See docs/delivery-verification.md.
CRD_EXCEPTIONS = {
    ("argoproj.io/v1alpha1", "Application"): "Argo CD installation version is not pinned by this local lab",
    ("argoproj.io/v1alpha1", "AppProject"): "Argo CD installation version is not pinned by this local lab",
    ("gateway.networking.k8s.io/v1", "Gateway"): "Optional Azure gateway needs the installed Gateway API CRD",
    ("gateway.networking.k8s.io/v1", "HTTPRoute"): "Optional Azure gateway needs the installed Gateway API CRD",
    ("autoscaling.k8s.io/v1", "VerticalPodAutoscaler"): "VPA learning addon needs its installed CRD",
}


def schema_objects(objects):
    core, exceptions = [], []
    for item in objects:
        key = (item["apiVersion"], item["kind"])
        if key in CRD_EXCEPTIONS:
            exceptions.append((key, item["metadata"]["name"]))
        else:
            core.append(item)
    return core, exceptions


def validate_schemas(objects, run=subprocess.run):
    binary = os.environ.get("KUBECONFORM_BIN") or str(
        ROOT / ".validation" / "tools" / ("kubeconform.exe" if os.name == "nt" else "kubeconform"))
    version = run([binary, "-v"], check=True, capture_output=True, text=True).stdout.strip()
    if version != KUBECONFORM_VERSION:
        raise ValueError(f"Expected kubeconform {KUBECONFORM_VERSION}, got {version!r}; run scripts/install-kubeconform.py")
    core, exceptions = schema_objects(objects)
    run([binary, "-strict", "-summary", "-kubernetes-version", KUBERNETES_VERSION,
         "-schema-location", SCHEMA_LOCATION], input="\n---\n".join(json.dumps(item) for item in core),
        text=True, check=True)
    for key in sorted({key for key, _ in exceptions}):
        print(f"SCHEMA EXCEPTION {key[0]} {key[1]}: {CRD_EXCEPTIONS[key]}")
    print(f"Schema validation: {len(core)} core resources; {len(exceptions)} explicit CRD exceptions.")
