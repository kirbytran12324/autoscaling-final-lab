# Metronome Tournament Autoscaling Lab

This repository contains a deterministic Pokémon Metronome simulator, a
restart-safe singleton tournament runner, Kubernetes and load-test manifests,
and an offline tournament report generator. The architecture and tournament
rules are defined in [docs/technical-design.md](docs/technical-design.md).

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
to one Ready replica. **Phase 7 HPA experiment: PASS.** Phase 10 remains
pending.

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

## Generate an offline tournament report

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

Optional evidence directories can be supplied without changing tournament
state:

```sh
REPORT_RESTART_EVIDENCE_DIR=/path/to/restart-evidence \
REPORT_AUTOSCALING_EVIDENCE_DIR=/path/to/autoscaling-evidence \
TOURNAMENT_STATE_ROOT=/path/to/tournament-state \
TOURNAMENT_RUN_ID=sample-32-001 \
npm run report
```

Restart evidence must contain the current harness `summary.txt` and
`checkpoint-before-interruption.json` for the selected run. For the accepted
Phase 7 view, set `REPORT_AUTOSCALING_EVIDENCE_DIR` to the recorder directory
containing `capture-status.json`, `metadata.json`, the HPA/replica/Pod/endpoint
and sample-status CSVs, `locust.log`, and the Locust HTML report. The report
validates collection status, sample counts, scale-out and return to one,
restart counts, Locust totals, and `servedBy` membership before rendering the
accepted timeline and results. Incomplete or conflicting Phase 7 evidence is
shown as incompatible rather than partially rendered. The earlier compatible
`autoscaling-timeline.csv` format remains supported for generic timelines.
When optional evidence is absent, the report shows explicit placeholders and
does not invent values.

The resulting HTML is self-contained and can be opened through `file://`; it
uses no CDN, external font, stylesheet, script, framework, or network request.
`results.jsonl` remains authoritative, and `report.html` is read-only derived
output that may be regenerated. Sample mode validates the 32-species pipeline
but does not replace the required full 1,025-species tournament.

## Test

```sh
cd simulator
npm test
```
