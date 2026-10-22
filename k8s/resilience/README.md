# Worker resilience lab

## Status and scope

Required hostname anti-affinity and the PDB have been deployed and tested.
The required-rule eviction/Pending/recovery sequence was observed on
2026-10-13. Preferred placement, topology spread, and actual rejection of a
second eviction remain untested. Interview explanation is pending.

Experiment captures remain local under
`evidence/experiments/resilience-required-20261013-073311/`; they are intentionally
excluded from this change. The observations above describe that local exercise,
not a cloud deployment or a newly repeated validation.

This overlay reuses the stateless simulator Deployment and Service, existing
probes, and existing resource requests/limits. It pins the simulator digest
selected by the development overlay when the starter was prepared.

It creates only a Namespace, Service and three-replica Deployment in
`resilience-lab`. No HPA, runner, PVC, Argo Application or AWS resources are
included. Three simulator Pods request 1500m CPU and 576Mi memory in total,
with aggregate limits of 3 CPU and 768Mi. Actual usage must be observed.

## Step 1: write the placement rule

Edit `deployment-patch.yaml` beneath `spec.template.spec`.

Goal: at most one Pod matching `app=metronome-simulator` per hostname in this
namespace. Use required Pod anti-affinity. Decide which topology key to use
from the worker labels inspected earlier. Ask for a hint if the structure is
unfamiliar; do not copy placement into the shared base or prod overlay.

Predict what happens to a replacement when only two workers are eligible.
Preferred anti-affinity is a later comparison, not yet an implemented variant.

Render before applying, from the repository root:

```powershell
kubectl --context docker-desktop kustomize k8s/resilience
```

The initial starter omitted anti-affinity and a PDB; the learner has now
completed both. Review changes before later deployments.

## Step 2: deploy after rule review

```powershell
kubectl --context docker-desktop apply -f k8s/resilience/namespace.yaml
kubectl --context docker-desktop apply --dry-run=server -k k8s/resilience
kubectl --context docker-desktop apply -k k8s/resilience
kubectl --context docker-desktop -n resilience-lab rollout status deployment/metronome-simulator --timeout=180s
kubectl --context docker-desktop -n resilience-lab get pods -l lab=worker-resilience -o wide
```

Verify three Ready Pods on three distinct workers and smoke-test the Service
before introducing a failure. If Pending or ImagePullBackOff appears, inspect
Pod events before changing configuration. Record actual observations.

The overlay uses maxSurge=0 and maxUnavailable=1. With hard hostname
anti-affinity, a default surge update could wait for a fourth distinct worker.
This lab chooses one-at-a-time replacement, allowing one unavailable replica.
Deployment rollout availability is separate from a PDB eviction budget.

## Later guided steps

1. Add a PDB after predicting its allowed eviction count.
2. Measure a bounded request stream through the lab Service.
3. Inspect all workloads on a candidate worker before cordoning it.
4. Cordon one reviewed worker and evict only this namespace's lab Pods through
   the Eviction API. Do not drain the entire shared worker.
5. Diagnose the replacement's scheduling failure and PDB status.
6. Compare preferred separation, recovery, and request continuity.
7. Restore any changed node scheduling state and verify existing workloads.

A cordon changes a shared node even though Pod eviction is scoped. Do not
perform it until its impact and restoration command have been reviewed.
Do not stop node containers, modify control-plane taints, or delete PVCs.

## Evidence and interview explanation

Capture before/after Pod names, UIDs, nodes, Ready status, EndpointSlices,
scheduler events, PDB status, request counts/failures, timestamps, and recovery.
Record separately: prepared configuration, observed results, and untested
claims. A Pod is bound once; recovery creates a replacement with a new UID.
A preferred rule does not automatically rebalance existing Pods.

Explain why required separation can block replacement despite spare CPU,
why a PDB constrains Eviction API requests but cannot prevent node failure,
and how EKS worker maintenance faces similar availability/capacity tradeoffs.
Local workers share a physical host; this does not prove AWS zone resilience.

Cleanup after the experiment removes only these lab resources:

```powershell
kubectl --context docker-desktop delete -k k8s/resilience
```

Deleting the lab does not uncordon a node. Restore node scheduling first.

References:
- https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/
- https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/
- https://kubernetes.io/docs/concepts/workloads/pods/disruptions/
