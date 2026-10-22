"""Install the checksum-pinned validator into ignored local tooling (no cluster access)."""
import hashlib
import io
from pathlib import Path
import platform
import tarfile
from urllib.request import urlopen
import zipfile

VERSION = "0.7.0"
ARCHIVES = {
    "Linux": ("kubeconform-linux-amd64.tar.gz", "c31518ddd122663b3f3aa874cfe8178cb0988de944f29c74a0b9260920d115d3"),
    "Windows": ("kubeconform-windows-amd64.zip", "9cb75551d81c909c2241ab383ced2be68363b5bfb15fd989badcc5a63bea5d7e"),
}
ROOT = Path(__file__).resolve().parents[1]


def install():
    system = platform.system()
    if system not in ARCHIVES or platform.machine().lower() not in {"amd64", "x86_64"}:
        raise SystemExit("The pinned installer supports Linux/Windows amd64; review a checksum for another platform.")
    archive, expected = ARCHIVES[system]
    url = f"https://github.com/yannh/kubeconform/releases/download/v{VERSION}/{archive}"
    with urlopen(url, timeout=60) as response:
        payload = response.read(32 * 1024 * 1024 + 1)
    if len(payload) > 32 * 1024 * 1024 or hashlib.sha256(payload).hexdigest() != expected:
        raise SystemExit("kubeconform archive checksum mismatch; nothing installed.")
    name = "kubeconform.exe" if system == "Windows" else "kubeconform"
    # Read only the named binary. Never extract archive paths to the filesystem.
    if archive.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(payload)) as bundle:
            binary = bundle.read(name)
    else:
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as bundle:
            binary = bundle.extractfile(name).read()
    target = ROOT / ".validation" / "tools" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(binary)
    target.chmod(0o755)
    print(f"Installed checksum-verified kubeconform v{VERSION}: {target}")


if __name__ == "__main__":
    install()
