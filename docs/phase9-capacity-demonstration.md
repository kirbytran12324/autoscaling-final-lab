# Phase 9 capacity and scheduler diagnosis

## Purpose

This experiment demonstrates a real Kubernetes scheduling-capacity limit. It
uses CPU requests to place one deliberately large, idle Pod on each eligible
worker and leaves one additional replica Pending. Acceptance requires a
scheduler-level `FailedScheduling` event containing `Insufficient cpu`; an
admission failure such as ResourceQuota `FailedCreate` would not pass.

## Cluster inventory and calculation

The [node inventory and request calculation](../evidence/experiments/phase9-capacity-001/node-capacity-and-requests.txt)
was captured at 10:23:11 on 2026-09-14 in Asia/Bangkok (`UTC+07:00`) from
committed revision [`e9a3342`](../evidence/experiments/phase9-capacity-001/git-revision.txt).
The cluster had three eligible workers, each with 12 CPU allocatable. The
12-CPU control-plane node had the standard `NoSchedule` taint and was not
eligible.

| Worker | Allocatable CPU | Existing requests | Free requested CPU |
| --- | ---: | ---: | ---: |
| desktop-worker | 12000m | 250m | 11750m |
| desktop-worker2 | 12000m | 700m | 11300m |
| desktop-worker3 | 12000m | 300m | 11700m |

The existing requests include the fixed Locust Deployment's `100m` request on
`desktop-worker3`; Locust was not scaled down. Let `L` be the largest eligible
worker's allocatable CPU and `q` the demo Pod request:

```text
L = 12000m
L / 2 = 6000m
q = 6100m

q > L / 2                  => 6100m > 6000m
q <= minimum free CPU      => 6100m <= 11300m
requested replicas         = 3 eligible workers + 1 = 4
```

Because `q` is greater than half of each worker's allocatable CPU, no worker
can fit two demo Pods. Because `q` is below every worker's free requested CPU,
one demo Pod can fit on each worker without displacing the existing workloads.

## Configuration and procedure

The committed [capacity-demo overlay](../k8s/capacity-demo/) creates an
isolated `capacity-demo` namespace and a four-replica Deployment. Each Pod runs
an idle `busybox:1.36` sleep process, requests and limits CPU at `6100m`, and
requests only `16Mi` memory. Required node affinity excludes nodes carrying the
control-plane role label. No ResourceQuota is used.

```sh
kubectl kustomize k8s/capacity-demo
kubectl apply -k k8s/capacity-demo
kubectl -n capacity-demo get deployment,pods -o wide
kubectl -n capacity-demo get events --sort-by=.metadata.creationTimestamp
kubectl -n capacity-demo get pods -l app=cpu-capacity-demo \
  --field-selector=status.phase=Pending -o yaml
kubectl delete -k k8s/capacity-demo
```

Before reproducing, recalculate current per-node requests. The committed
`6100m` value is appropriate for the captured three homogeneous 12-CPU workers;
it is not a portable constant for a different cluster.

## Result and diagnosis

The live [Deployment snapshot](../evidence/experiments/phase9-capacity-001/deployment.yaml)
reported four desired replicas, three Ready and available replicas, and one
unavailable replica. The [placement table](../evidence/experiments/phase9-capacity-001/pod-placement.txt)
shows one Running Pod on each of `desktop-worker`, `desktop-worker2`, and
`desktop-worker3`, plus a fourth Pod with no assigned node.

The relevant-field [Pending Pod snapshot](../evidence/experiments/phase9-capacity-001/pending-pod.yaml)
records `phase: Pending` and a `PodScheduled=False` condition with reason
`Unschedulable`. The [scheduler event](../evidence/experiments/phase9-capacity-001/scheduler-events.yaml)
has type `Warning`, reason `FailedScheduling`, and the decisive message:

```text
0/4 nodes are available: 1 node(s) had untolerated taint(s),
3 Insufficient cpu.
```

The one tainted node is the control plane. Each of the other three nodes had
already accepted one `6100m` demo request, leaving less than `6100m` requested
CPU capacity. The evidence is therefore a scheduler-level CPU-capacity failure,
not an image, memory, affinity, admission, or runtime-utilization failure.
Preemption was not helpful because no eligible node had a lower-priority victim
whose removal would free the requested CPU.

Kubernetes schedules against requests rather than current CPU usage, which is
why sleeping Pods can demonstrate this limit safely. This local Docker Desktop
kind cluster has no cloud-provider node-group API, so no cluster autoscaler can
add a worker. In a managed cloud cluster with a configured autoscaling node
group, an unschedulable Pod like this could trigger node scale-out if a
permitted node type could satisfy the request.

## Limitations

- This is a deterministic scheduler-capacity demonstration, not application
  load or performance evidence.
- The exact `6100m` request depends on the captured node sizes and existing
  requests.
- It demonstrates Pending behavior in a fixed local cluster, not successful
  node provisioning by a cloud cluster autoscaler.
- The isolated demo namespace was
  [deleted after capture](../evidence/experiments/phase9-capacity-001/cleanup.txt);
  the evidence is the durable experiment record.

## Verdict

**Phase 9 capacity and scheduler diagnosis: PASS.** Three Pods scheduled, the
fourth remained Pending, and the default scheduler reported
`FailedScheduling` with `3 Insufficient cpu`.
