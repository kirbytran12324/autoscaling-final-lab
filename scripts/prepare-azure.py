"""Create reviewable deployment overlays without modifying local lab manifests."""
import argparse
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", required=True, help="ACR login server, e.g. mylab.azurecr.io")
    parser.add_argument("--image-tag", required=True, help="Full verified Git commit SHA")
    parser.add_argument("--output", required=True, type=Path, help="New output directory")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9]{5,50}\.azurecr\.io", args.registry):
        parser.error("registry must be a lowercase Azure Container Registry login server")
    if not re.fullmatch(r"[0-9a-f]{40}", args.image_tag):
        parser.error("image-tag must be a full 40-character lowercase commit SHA")
    output = args.output.resolve()
    if output.is_relative_to(ROOT / "k8s"):
        parser.error("output must be outside the source k8s tree")
    if output.exists():
        parser.error("output already exists; choose a new directory for this release")
    shutil.copytree(ROOT / "k8s", output / "k8s")
    for path in (output / "k8s" / "azure").rglob("kustomization.yaml"):
        source = path.read_text(encoding="utf-8")
        source = source.replace("metronomelab.azurecr.io/", f"{args.registry}/")
        source = source.replace("REPLACE_WITH_COMMIT_SHA", f'"{args.image_tag}"')
        path.write_text(source, encoding="utf-8")
    print(f"Prepared {output / 'k8s' / 'azure'}")
    print("Render and review each overlay; this command does not contact Azure or Kubernetes.")


if __name__ == "__main__":
    main()
