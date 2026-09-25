# Metronome Tournament Autoscaling Lab

This repository contains a deterministic Pokémon Metronome simulator, a
restart-safe singleton tournament runner, Kubernetes and load-test manifests,
and an offline tournament report generator. The architecture and tournament
rules are defined in [docs/technical-design.md](docs/technical-design.md).

## Assignment scope and evidence

The required autoscaling assignment is complete in Phases 6–9 and the
cost/performance analysis below. Tournament operations, offline reporting, CI,
and GitOps are completed extensions; they are useful demonstrations but are
not required to establish the autoscaling results.

| Scope | Evidence |
| --- | --- |
| Resource sizing | [Phase 6](docs/phase6-resource-sizing.md) |
| HPA scale-out/in | [Phase 7](docs/phase7-hpa-autoscaling.md) |
| VPA comparison | [Phase 8](docs/phase8-vpa-autoscaling.md) |
| Pending-Pod diagnosis | [Phase 9](docs/phase9-capacity-demonstration.md) |
| Cost/performance | [README](#cost-and-performance-tradeoff) |
| Tournament runner/report | [Extension](#tournament-runner-and-completed-run-evidence) |
| CI and GitOps | [Extension](#ci-and-gitops) |

## Architecture

![Metronome simulator Kubernetes architecture](docs/metronome-autoscaling-architecture.drawio.png)

The diagram represents the core autoscaling and tournament system. The
separate GitOps extension deploys dev and prod Kustomize overlays through Argo
CD and is documented under [CI and GitOps](#ci-and-gitops); those environments
are intentionally outside this core-system diagram.

The simulator is the only horizontally autoscaled workload. Locust, in the
separate `load-testing` namespace, and the singleton tournament runner both
send battle requests through the simulator's ClusterIP Service. The Service
selects Ready simulator Pods, while the simulator Deployment and its
ReplicaSet own and maintain those Pods.

The autoscaling control loop has separate observed and desired inputs. Pod
resource usage is exposed by Metrics Server through the Kubernetes API, while
the HPA resource defines the 70% CPU target and the one-to-six replica range.
The HPA controller compares those inputs and updates the simulator
Deployment's desired replica count; the Deployment and ReplicaSet then create
or remove Pods. The recommendation-only VPA observes the same workload and
writes CPU and memory recommendations to VPA status, but `updateMode: "Off"`
and `controlledValues: RequestsOnly` prevent it from mutating the workload or
competing with the HPA.

The operator runs Kustomize, `kubectl`, Locust port-forwarding, and the
recording scripts from the workstation. The recorders query the Kubernetes
API and write immutable per-run artifacts beneath `evidence/experiments/`;
tournament artifacts are retained separately beneath
`evidence/tournaments/runs/`. See
[Architecture and workload ownership](docs/technical-design.md#architecture-and-workload-ownership)
for the meaning of every connection and boundary in the diagram.

## Reproduce the lab

### Scope

These instructions reproduce the accepted lab configuration on an existing
Kubernetes cluster. The repository does not provision the Docker Desktop
cluster or install the upstream VPA controllers.

The accepted environment used Docker Desktop's `kind` provisioner with three
worker nodes and one tainted control-plane node. Other clusters may run the
application, but the Phase 9 capacity calculation must be repeated for their
actual node sizes and existing resource requests.

### Prerequisites

Install or provide:

- Docker Desktop with Kubernetes enabled;
- `docker`;
- `kubectl` with Kustomize support;
- Node.js 24 and npm for local simulator tests;
- Python 3 and Locust 2.46.2 for local load-test tests;
- Bash, `jq`, `awk`, `git`, `sha256sum`, `timeout`, and standard core utilities;
- a default filesystem StorageClass; and
- Vertical Pod Autoscaler 1.7.1.

Before changing the cluster, verify the selected context and available
capacity:

```sh
git status --short
kubectl config current-context
kubectl version
kubectl get nodes -o wide
kubectl get storageclass
```

Use a clean, committed worktree for acceptance evidence.

### Install Metrics Server

The repository vendors Metrics Server 0.8.0 with a Docker Desktop-only
kubelet TLS patch:

```sh
kubectl apply -k k8s/addons/metrics-server

kubectl wait \
  --for=condition=Available \
  apiservice/v1beta1.metrics.k8s.io \
  --timeout=120s

kubectl top nodes
kubectl top pods --all-namespaces
```

The insecure kubelet TLS option is intended only for this local lab. It must
not be copied into a production or untrusted cluster.

### Install Vertical Pod Autoscaler

VPA is not built into the repository. Install the accepted upstream
`vertical-pod-autoscaler/v1.7.1` release from a separate checkout:

```sh
git clone \
  --depth 1 \
  --branch vertical-pod-autoscaler/v1.7.1 \
  https://github.com/kubernetes/autoscaler.git \
  /path/to/kubernetes-autoscaler

cd /path/to/kubernetes-autoscaler/vertical-pod-autoscaler
./hack/vpa-up.sh
```

The `hack` directory used here is inside the upstream
`vertical-pod-autoscaler` directory, not the similarly named directory at the
root of the autoscaler repository.

Verify the three VPA components and API:

```sh
kubectl -n kube-system get deployment \
  vpa-recommender \
  vpa-updater \
  vpa-admission-controller

kubectl api-resources | grep -i verticalpodautoscaler
```

The repository's `k8s/vpa` overlay creates only the simulator's VPA
configuration. It does not install these controllers or their CRDs.

### Test and build the application images

Run the simulator suite:

```sh
cd simulator
npm ci
npm test
cd ..
```

With Locust 2.46.2 available locally, run its focused tests:

```sh
python3 -m unittest discover \
  -s load-test \
  -p 'test_*.py'
```

Build the exact image tags referenced by the manifests:

```sh
docker build \
  --tag metronome-simulator:phase10 \
  simulator

docker build \
  --tag metronome-load-test:0.1.2 \
  load-test
```

The images must be available to every Kubernetes worker that may run the
Pods. The accepted Docker Desktop environment uses its local image
integration. A different cluster must load these images into each node or pull
them from an accessible registry. Do not continue if a Pod reports
`ImagePullBackOff`.

### Render and validate the final manifests

Inspect the rendered resources before applying them:

```sh
kubectl kustomize k8s/hpa
kubectl kustomize k8s/load-test
kubectl kustomize k8s/vpa
kubectl kustomize k8s/jobs/runner
```

Validate them against the selected cluster without creating resources:

```sh
kubectl apply --dry-run=server -k k8s/hpa
kubectl apply --dry-run=server -k k8s/load-test
kubectl apply --dry-run=server -k k8s/vpa
kubectl apply --dry-run=server -k k8s/jobs/runner
```

### Deploy the final autoscaling system

Deploy the simulator and HPA, the fixed-replica Locust workload, and the
recommendation-only VPA:

```sh
kubectl apply -k k8s/hpa
kubectl apply -k k8s/load-test
kubectl apply -k k8s/vpa
```

Wait for both Deployments:

```sh
kubectl -n autoscaling-lab rollout status \
  deployment/metronome-simulator \
  --timeout=180s

kubectl -n load-testing rollout status \
  deployment/metronome-load-test \
  --timeout=180s
```

Verify the resulting boundaries:

```sh
kubectl -n autoscaling-lab get deployment,service,hpa,vpa
kubectl -n load-testing get deployment,service
kubectl -n autoscaling-lab top pods \
  -l app=metronome-simulator
```

Only `metronome-simulator` should be an HPA target. Locust must remain at one
replica, VPA must remain in `Off` mode, and no tournament runner should be
started until its run identity has been deliberately selected.

## Phase 6 resource-sizing evidence

Phase 6 is complete. It measured one fixed simulator Pod with one fixed Locust
replica, Metrics Server, and cgroup throttling counters. No HPA was present, so
these results establish resource sizing rather than autoscaling. See the
[canonical Phase 6 analysis and decision record](docs/phase6-resource-sizing.md)
for the full method, results, interpretation, limitations, and file-level
evidence links. The captured CSV/JSON artifacts and per-run Locust HTML reports
remain the authoritative measurement evidence.

| Resource | Request | Limit |
| --- | ---: | ---: |
| CPU | 500m | 1 CPU |
| Memory | 192Mi | 256Mi |

In the matched one-user validation, throughput increased from 20.21 to 51.80
RPS (+156%), average latency fell from 49.3 to 19.2 ms (-61%), and p95 latency
fell from 110 to 36 ms (-67%). Failures and restarts remained zero, peak memory
stayed stable at 180Mi, and throttled periods fell from 98.3% to 17.0%. The
remaining throttling confirms that one core is still a real ceiling; Phase 7
subsequently validated HPA scale-out and scale-in from the `500m` request
baseline.

Phase 6 evidence directories:

- [idle](evidence/experiments/phase6-idle-001/)
- [1 user, original resources](evidence/experiments/phase6-1-user-001/)
- [2 users, original resources](evidence/experiments/phase6-2-user-001/)
- [3 users, original resources](evidence/experiments/phase6-3-user-001/)
- [1 user, selected resources](evidence/experiments/phase6-1-user-rightsized-001/)

The two-user directory incorrectly records `phase6-1-user-001` as its internal
experiment ID; its Locust report confirms two users ran. The original evidence
is preserved unchanged as a known labeling exception. A per-run Locust HTML
report is sufficient when it includes request totals, RPS, failures, latency
percentiles, user history, and timestamps. CSV exports are optional supporting
evidence and must not be reconstructed from HTML and presented as original
exports.

### Future resource captures

The capture script is read-only with respect to Kubernetes: it does not start
Locust, change replicas or resources, apply manifests, or write to the
tournament PVC. It requires settled, single-replica simulator and Locust
Deployments, no HPA target, and working Metrics Server samples. Use a unique,
new directory for every run. For example:

```sh
EXPERIMENT_ID=future-1-user-001 \
EXPERIMENT_PROFILE=load \
EVIDENCE_LOCUST_USERS=1 \
EVIDENCE_LOCUST_SPAWN_RATE=1 \
EVIDENCE_LOCUST_RUN_SECONDS=180 \
CAPTURE_DURATION_SECONDS=240 \
SAMPLE_INTERVAL_SECONDS=15 \
./scripts/capture-resource-usage.sh \
  evidence/experiments/future-1-user-001
```

Run acceptance captures from a clean, committed worktree. The script rejects
an output path that already exists, including an empty directory, and never
appends to prior evidence. For each experiment:

1. Choose a unique experiment ID and a new output path that does not exist.
2. For a load profile, ensure the Locust UI is reachable. If needed, run
   `kubectl -n load-testing port-forward service/metronome-load-test 8089:8089`
   and open `http://127.0.0.1:8089`.
3. Set `EXPERIMENT_PROFILE=load` and make the `EVIDENCE_LOCUST_USERS`,
   `EVIDENCE_LOCUST_SPAWN_RATE`, and `EVIDENCE_LOCUST_RUN_SECONDS` labels match
   the intended UI settings. These values record metadata only; they do not
   configure or stop Locust.
4. Start the finite Kubernetes capture command before starting Locust. Then
   configure the same user count and spawn rate in the UI and start the load.
5. Run Locust for the labelled duration and stop it in the UI. The Kubernetes
   capture intentionally continues after Locust stops until its longer capture
   duration ends and final validation completes.
6. Download the per-run HTML report and place it in the new evidence directory
   after the capture exits. The HTML report is required; Locust CSV exports are
   optional supporting evidence. Do not use process-lifetime `--csv` or
   `--html` files as experiment boundaries, and do not reconstruct missing CSV
   exports from HTML.
7. Confirm the command exited zero and `capture-status.json` reports
   `"status": "complete"`, `"finalValidation": "ok"`, and no failed samples.
8. For an idle capture, use `EXPERIMENT_PROFILE=idle`, set all three
   `EVIDENCE_LOCUST_*` labels to `0`, start only the Kubernetes capture, and do
   not start a Locust run or expect a Locust HTML report.
9. Never reuse or rerun against a previous experiment directory.

CPU-throttling counters are cumulative and must only be differenced within the
same container ID.

## Phase 7 HPA experiment captures

Phase 7 is complete. The accepted
[`phase7-hpa-3-users-150s-001` experiment](docs/phase7-hpa-autoscaling.md)
used a 70% CPU target, a one-to-six replica range, and a 150-second scale-down
stabilization window. Under three Locust users, the simulator followed
`1 → 2 → 3 → 5 → 6 → 4 → 1`; all 13,033 requests succeeded, every Ready replica
served traffic, no simulator container restarted, and the Deployment returned
to one Ready replica. **Phase 7 HPA experiment: PASS.** This controlled
autoscaling experiment is separate from tournament execution and its telemetry
is not embedded in the canonical tournament report.

`scripts/capture-hpa-experiment.sh` records the simulator HPA, Deployment,
Pods, CPU and memory samples, and Service EndpointSlices on a fixed schedule.
It also saves configuration snapshots, events, and the Locust log. The script
uses read-only Kubernetes commands: it does not apply manifests, change
replicas, or start or stop Locust. The `EVIDENCE_LOCUST_*` values are metadata
labels for the intended manual UI settings; they do not control Locust.

Acceptance captures require a clean, committed worktree and a unique output
path that does not already exist. `ALLOW_DIRTY_WORKTREE=1` is available only
for development smoke tests and is recorded. A future reproduction using the
accepted 150-second scale-down configuration can use:

```sh
EXPERIMENT_ID=phase7-hpa-reproduction-001 \
EVIDENCE_LOCUST_USERS=3 \
EVIDENCE_LOCUST_SPAWN_RATE=1 \
EVIDENCE_LOCUST_RUN_SECONDS=180 \
CAPTURE_DURATION_SECONDS=600 \
SAMPLE_INTERVAL_SECONDS=15 \
./scripts/capture-hpa-experiment.sh \
  evidence/experiments/phase7-hpa-reproduction-001
```

Run an experiment in this exact order:

1. From a clean worktree, run `kubectl apply -k k8s/load-test` and then
   `kubectl apply -k k8s/hpa`. Wait until the simulator and Locust are each
   settled at one Ready Pod. Do not start Locust yet.
2. Start a port-forward with
   `kubectl -n load-testing port-forward service/metronome-load-test 8089:8089`
   and open `http://127.0.0.1:8089`.
3. Start the capture command with labels matching the user count, spawn rate,
   and run time you will enter in the Locust UI.
4. Start Locust manually in the UI. Hold the configured load for the labelled
   duration, then stop it manually so Locust emits the final
   `servedBy distribution:` line.
5. Leave the recorder running after load stops so it can observe scale-in. Do
   not change the Deployment, Service, HPA, images, or Locust Pod during the
   capture.
6. After the recorder exits, confirm `capture-status.json` has `"status":
   "complete"`, `"finalValidation": "ok"`, and zero failed samples. Then
   export the per-run Locust HTML report into the new evidence directory.
7. Evaluate experiment acceptance separately using the replica timeline,
   EndpointSlices, `servedBy` distribution, and Locust performance report.
   `complete` means collection and configuration validation succeeded; it does
   not claim that scale-out, recovery, or service-level acceptance passed.

## Phase 8 VPA recommendation comparison

Phase 8 is complete. The recommendation-only VPA uses `updateMode: "Off"` for
the `simulator` container, observes CPU and memory, and controls requests only.
The canonical [Phase 8 analysis and evidence record](docs/phase8-vpa-autoscaling.md)
links the installed VPA version and revision, observation transcript, VPA
objects, resource snapshots, `kubectl top` captures, timestamps, and Locust
report.

| Resource | Manual request | Settled VPA target | Decision |
| --- | ---: | ---: | --- |
| CPU | 500m | 511m | Retain 500m; the VPA target is only 11m (2.2%) higher. |
| Memory | 192Mi | 250Mi | Retain 192Mi; 250Mi is the recommender's default floor, not demonstrated usage. |

The settled CPU recommendation independently supports the Phase 6 request.
VPA remains Off because automatic CPU-request changes would change the
CPU-utilization HPA's denominator: 70% is approximately `350m` at a `500m`
request but approximately `358m` at `511m`. Allowing both controllers to
change the same scaling signal could create interacting control loops.

To reproduce the manifest deployment and inspect recommendations:

```sh
kubectl apply -k k8s/vpa
kubectl -n autoscaling-lab get vpa metronome-simulator -o yaml
kubectl -n autoscaling-lab describe vpa metronome-simulator
kubectl -n autoscaling-lab top pods -l app=metronome-simulator
kubectl -n autoscaling-lab get deployment metronome-simulator \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="simulator")].resources}'
```

Collect idle, sustained-load, end-of-load, and recovery snapshots with local
timestamps. Keep the HPA and workload configuration fixed, retain
`updateMode: "Off"`, and export the per-run Locust HTML report. A short-history
upper bound is not a sizing decision; compare the settled target with measured
usage and the manually selected request.

## Phase 9 capacity demonstration

Phase 9 is complete. The canonical
[capacity and scheduler diagnosis](docs/phase9-capacity-demonstration.md)
records the node inventory, sizing calculation, committed manifest, Pod
conditions, placement, and scheduler event. On three 12-CPU workers with
11,300m or more free requested CPU, four Pods each requested `6100m`. One Pod
scheduled per worker and the fourth remained Pending with a scheduler
`FailedScheduling` event reporting `3 Insufficient cpu`. The control-plane
node was ineligible because of its `NoSchedule` taint. Locust remained running,
and its `100m` request was included in the calculation.

Recalculate requests before reproducing; `6100m` is specific to the captured
cluster state. Then apply, inspect, and remove the isolated demo:

```sh
kubectl apply -k k8s/capacity-demo
kubectl -n capacity-demo get deployment,pods -o wide
kubectl -n capacity-demo get events --sort-by=.metadata.creationTimestamp
kubectl delete -k k8s/capacity-demo
```

Kubernetes makes this decision from requests, not current utilization. A local
Docker Desktop kind cluster cannot add cloud nodes, while a managed cluster
autoscaler could react to an unschedulable Pod when a configured node group has
a node type capable of satisfying the request.

The three Docker Desktop worker Nodes are separate Kubernetes scheduling
objects, but they share the physical host and Docker Desktop VM capacity. Their
reported aggregate allocatable CPU therefore demonstrates scheduler accounting;
it must not be interpreted as the same amount of independent physical CPU.

## Cost and performance tradeoff

This estimate uses Linux On-Demand Amazon EC2 pricing in AWS Asia Pacific
(Singapore), `ap-southeast-1`, retrieved on 2026-09-14. It models the accepted
six-replica HPA peak as a controlled lab capacity scenario rather than a
production traffic forecast. A month is approximated as 730 running hours.

At the selected sizing, six simulator Pods request a total of `3` vCPU and
`1152Mi` memory. A compute-optimized `c7i.xlarge` provides 4 vCPU and 8 GiB,
leaving simplified headroom for Kubernetes system processes. At 2×
over-provisioning, the same six Pods would request `6` vCPU and `2304Mi`;
the comparison therefore uses a `c7i.2xlarge` with 8 vCPU and 16 GiB.

| Scenario | Per-Pod request | EC2 worker | EC2 hourly | EC2 monthly | EKS control plane | Total monthly |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Selected sizing | 500m CPU, 192Mi memory | `c7i.xlarge` | $0.2058 | $150.23 | $73.00 | $223.23 |
| 2× over-provisioned | 1000m CPU, 384Mi memory | `c7i.2xlarge` | $0.4116 | $300.47 | $73.00 | $373.47 |

The 2× case adds approximately `$150.23` per month. Worker compute doubles,
while the modeled total rises by approximately 67% because the EKS
standard-support control-plane charge remains fixed at `$0.10` per hour.

The selected `500m` CPU request is supported by both fixed-replica measurements
and VPA recommendations. In the matched one-user validation, throughput
increased from 20.21 to 51.80 RPS, average latency fell from 49.3 to 19.2 ms,
p95 fell from 110 to 36 ms, and throttled periods fell from 98.3% to 17.0%.
The accepted HPA experiment subsequently served 13,033 requests with zero
failures and zero simulator restarts while scaling from one to six Pods and
back to one. The settled VPA CPU target of `511m` independently remained close
to the selected request.

Doubling requests would not guarantee double performance. With an unchanged
70% HPA target, doubling the CPU request would raise the effective per-Pod
target from approximately 350m to 700m and could delay scale-out. Additional
capacity is valuable for bursts, rolling updates and node failure, but paying
for persistently unused capacity wastes money and reduces scheduling density.

Under-provisioning has the opposite risk. The original fixed-replica evidence
confirmed severe CPU throttling and materially worse latency and throughput.
Larger exploratory loads showed diminishing throughput returns and increasing
latency, consistent with approaching a workload or shared-host capacity
boundary, although those tests did not isolate one limiting component. No
accepted experiment observed request failures, simulator restarts or memory
exhaustion.

This is a simplified compute comparison, not a production AWS architecture.
It assumes one continuously running worker and excludes EBS volumes, public
IPv4 addresses, data transfer, load balancers, taxes and high-availability
worker duplication. A production estimate would require real traffic history,
multiple Availability Zones and longer measurements.

Sources: [Amazon EC2 On-Demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/),
[Amazon EKS pricing](https://aws.amazon.com/eks/pricing/), and the
[official regional EC2 price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/ap-southeast-1/index.csv).

## Extensions

The tournament runner/report and CI/GitOps work below extend the completed
autoscaling assignment. They do not replace the Phase 6–9 evidence above.

### Tournament runner and completed-run evidence

Five committed runs are complete. Their manifests are retained under
`k8s/jobs/`, and their validated artifacts and self-contained reports are under
`evidence/tournaments/runs/`.

| Run | Concurrency | Accepted results | Champion |
| --- | ---: | ---: | --- |
| `sample-32-001` | 2 | 144 | Rayquaza |
| `sample-32-002` | 6 | 146 | Kyogre |
| `full-1025-001` | 6 | 130,969 | Giratina |
| `full-1025-002` | 10 | 130,975 | Magearna |
| `full-1025-003` | 15 | 130,968 | Solgaleo |

The accepted totals can differ between runs because each best-of-three
knockout series stops when a competitor reaches two wins, while draws and the
seven-game safety cap can require additional games.

The first full run was interrupted by a failure strongly consistent with V8 heap exhaustion under the original 512Mi container limit. Its authoritative state
remained valid at 130,962 accepted results. The singleton recovery Job kept the
same run identity, seed, image, concurrency, and PVC, raised the runner request
and limit to `1Gi` and `2Gi`, appended the seven missing knockout results, and
completed at 130,969 with Giratina as champion. The evidence boundary and the
limits of that diagnosis are recorded in the
[Phase 10 incident report](docs/phase10-runner-memory-incident.md).

The later `full-1025-002` and `full-1025-003` runs both completed without that
recovery path. From committed metadata, concurrency 10 completed in 24m 08.838s
and concurrency 15 completed in 26m 23.833s. The concurrency-15 run was
therefore not materially faster; it was about 2m 15s slower. Higher concurrency
only increases parallel HTTP simulation. Accepted responses enter one serialized
durability path: each result is appended and flushed before an atomically
written and flushed checkpoint advances. That serialized, durability-first persistence path is the leading explanation for the observed throughput ceiling, although storage latency was not instrumented. More HTTP workers therefore do not necessarily increase end-to-end throughput. These two runs used different
seeds and are operational comparisons, not a controlled benchmark.

The PVC uses `ReadWriteOnce`, which is a single-node attachment mode rather
than a single-Pod writer guarantee. Writer exclusivity comes from operating one
singleton runner Job at a time; the runner has no multi-writer coordination.

Export a newly completed PVC run with the committed helper:

```sh
bash scripts/export-tournament-run.sh <run-id>
```

The script mounts the PVC read-only in a temporary Pod, copies one completed
run into a new `evidence/tournaments/runs/<run-id>/` directory, validates it by
generating `report.html`, records report-generator provenance, and writes and
verifies checksums. It refuses to overwrite an existing export.

To refresh only the derived report and its provenance for an already exported
run, without reading from or changing the PVC, use:

```sh
bash scripts/export-tournament-run.sh --refresh-report <run-id>
```

### Generate an offline tournament report

Use an already completed run. From `simulator/`:

```sh
TOURNAMENT_STATE_ROOT=/path/to/tournament-state \
TOURNAMENT_RUN_ID=sample-32-001 \
npm run report
```

The command validates all canonical run artifacts and atomically writes:

```text
<TOURNAMENT_STATE_ROOT>/runs/<TOURNAMENT_RUN_ID>/report.html
```

The report accepts no restart, recovery, or autoscaling evidence inputs. It is
derived only from the canonical completed tournament artifacts. Phase 7 Pod
readiness, resource, EndpointSlice, replica, and load-test evidence remains in
its standalone experiment record.

The report groups accepted results by their `servedBy` value and displays
accepted counts, shares, and stage totals for each reported hostname. This is
response attribution only; it does not infer Pod identity, readiness, node
placement, restart count, simultaneous availability, or lifecycle.

The resulting HTML is self-contained and can be opened through `file://`; it
uses no CDN, external font, stylesheet, script, framework, or network request.
`results.jsonl` remains authoritative, and `report.html` is read-only derived
output that may be regenerated. Sample mode validates the 32-species pipeline
without claiming a full-roster result; the three committed full runs contain
the complete 1,025-species tournaments.

### CI and GitOps

The CI extension tests and builds the simulator on relevant pull requests. On
pushes to `main` that change the simulator or release workflow, the release
workflow retests the code and publishes
`ghcr.io/<repository-owner>/metronome-simulator:<full-commit-SHA>`.

The GitOps extension defines separate dev and prod Kustomize overlays and Argo
CD Applications with automated synchronization, pruning, and self-healing. The
committed [GitOps lab record](docs/gitops-lab.md) covers initial sync, live-drift
correction, and recovery by reverting a broken Git change.

CI tests and publishes immutable images, while Argo CD reconciles the Kustomize
overlays. In the current local extension, image promotion into an overlay is a
deliberate Git change rather than an automated CI-to-CD handoff. In particular,
the release workflow publishes a full-SHA GHCR tag, while the current overlays
refer to local-style tags `80fd0c0` and `phase10`; no workflow updates an overlay
to a newly published GHCR tag.

## Test

```sh
cd simulator
npm test
```
