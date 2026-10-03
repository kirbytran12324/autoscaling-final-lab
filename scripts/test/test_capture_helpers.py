"""Exercise sourced capture policies without any Kubernetes connection."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class CapturePolicies(unittest.TestCase):
    def run_policy(self, policy, code, *arguments):
        sources = f'source "{ROOT}/scripts/lib/capture-common.sh"; source "{ROOT}/scripts/lib/{policy}-guards.sh"; '
        return subprocess.run(['bash', '-c', sources + code, 'capture-test', *arguments], capture_output=True, text=True)

    def test_hpa_refuses_mutating_commands(self):
        result = self.run_policy('hpa', 'run_kubectl apply -f forbidden.yaml')
        self.assertEqual(result.returncode, 64)
        self.assertIn('refusal of non-read-only', result.stderr)

    def test_capture_fingerprints_preserve_policy_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'deployment.json'
            value = {'metadata': {'uid': 'deployment-1', 'generation': 1},
                     'spec': {'replicas': 1, 'template': {'image': 'simulator:1'}}}
            path.write_text(json.dumps(value))
            resource = self.run_policy('resource', 'deployment_fingerprint "$1"', str(path)).stdout
            hpa = self.run_policy('hpa', 'simulator_deployment_fingerprint_for "$1"', str(path)).stdout
            value['spec']['replicas'] = 6
            value['metadata']['generation'] = 2
            path.write_text(json.dumps(value))
            self.assertNotEqual(resource, self.run_policy('resource', 'deployment_fingerprint "$1"', str(path)).stdout)
            self.assertEqual(hpa, self.run_policy('hpa', 'simulator_deployment_fingerprint_for "$1"', str(path)).stdout)
            value['spec']['template']['image'] = 'simulator:2'
            path.write_text(json.dumps(value))
            self.assertNotEqual(hpa, self.run_policy('hpa', 'simulator_deployment_fingerprint_for "$1"', str(path)).stdout)
            self.assertEqual(len(hpa.strip()), 64)

    def test_invalid_configuration_stops_before_cluster_access(self):
        for name in ['capture-resource-usage.sh', 'capture-hpa-experiment.sh']:
            result = subprocess.run(['bash', str(ROOT / 'scripts' / name)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('exactly one new output directory is required', result.stderr)


if __name__ == '__main__':
    unittest.main()
