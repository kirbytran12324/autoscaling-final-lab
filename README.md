# Metronome Tournament Autoscaling Lab

This repository contains a deterministic Pokémon Metronome simulator, a
restart-safe singleton tournament runner, Kubernetes and load-test manifests,
and an offline tournament report generator. The architecture and tournament
rules are defined in [docs/technical-design.md](docs/technical-design.md).

## Phase 6 resource-sizing evidence

Phase 6 measures and right-sizes the existing single simulator Pod before any
HPA is added. The capture script is read-only with respect to Kubernetes: it
does not start Locust, change replicas or resources, apply manifests, or write
to the tournament PVC. It refuses to run unless the simulator has one replica,
Locust has one fixed replica, neither Deployment is targeted by an HPA, and
Metrics Server can return container samples.

Use a brand-new directory for every idle or load run. The script rejects any
path that already exists, including an empty directory, and never appends to a
previous experiment. For example, prepare the 1-user run from the repository
root with:

```sh
EXPERIMENT_ID=phase6-1-user-001 \
EXPERIMENT_PROFILE=load \
EVIDENCE_LOCUST_USERS=1 \
EVIDENCE_LOCUST_SPAWN_RATE=1 \
EVIDENCE_LOCUST_RUN_SECONDS=180 \
CAPTURE_DURATION_SECONDS=240 \
SAMPLE_INTERVAL_SECONDS=15 \
./scripts/capture-resource-usage.sh \
  evidence/experiments/phase6-1-user-001
```

Run acceptance captures only from a clean, committed Git worktree so the
recorded revision reconstructs the exact source. The script enforces this by
default. `ALLOW_DIRTY_WORKTREE=1` is available only for local development smoke
tests and is recorded explicitly in metadata; do not use it for acceptance
evidence.

`CAPTURE_DURATION_SECONDS` and `SAMPLE_INTERVAL_SECONDS` configure only the
finite Kubernetes evidence capture. `EVIDENCE_LOCUST_USERS`,
`EVIDENCE_LOCUST_SPAWN_RATE`, and `EVIDENCE_LOCUST_RUN_SECONDS` are immutable
metadata labels; they do **not** configure the Locust web UI or stop its run.
Locust is a closed workload with zero wait time, so its user setting is
concurrency, not a requested RPS. For an idle capture, use
`EXPERIMENT_PROFILE=idle` and set all three Locust labels to `0`.

For each experiment:

1. Choose a unique experiment ID and a brand-new, not-yet-created directory.
2. Start the capture command for a finite duration.
3. For a load profile, open the existing Locust web UI and configure the same
   user count and spawn rate recorded by the `EVIDENCE_...` labels. If the UI
   is not already reachable, use `kubectl -n load-testing port-forward
   service/metronome-load-test 8089:8089` and open
   `http://127.0.0.1:8089`.
4. Run for the labelled Locust duration, then stop the test in the Locust UI
   before the longer Kubernetes capture period ends.
5. Download the run's CSV data and HTML report using the Locust web UI.
6. After the capture command exits, place those downloads in the same unique
   experiment directory. Do not use the Deployment's process-lifetime
   `--csv` or `--html` files as experiment boundaries and do not add a PVC for
   these downloads.
7. Confirm the command exited zero and `capture-status.json` says
   `"status": "complete"`, `"finalValidation": "ok"`, and no failed samples.
   Warnings explicitly identify optional cgroup counters that the environment
   could not expose.
8. Never reuse or rerun against a previous experiment directory.

The raw authoritative evidence is `metadata.json`, `resources.csv`,
`replicas.csv`, `simulator-pods.csv`, `simulator-throttling.csv`,
`sample-status.csv`, `capture-status.json`, and the Locust CSV/HTML downloads.
Any later normalized timeline, chart, dashboard, or narrative is derived output
and must retain links to those raw files.

CPU throttling counters are cumulative for the lifetime of an individual
container. Later analysis must calculate deltas only between rows with the
same `container_id`; a container restart resets the counters. The pod and
throttling files record restart counts and container IDs so such boundaries
remain visible.

Every resource, replica, Pod, and throttling row has its own collection
timestamp. `sample-status.csv` also records each scheduled deadline and actual
sample start/end timestamps. Sampling stays aligned to fixed deadlines;
collection time is not added to every interval. A capture is complete only if
both Deployments are settled at one replica at the start and end, their
identity and complete specs are unchanged, their runtime image IDs still
match, and neither has become an HPA target. The Locust Pod UID, container ID,
and restart count must also remain unchanged because Locust keeps its run state
in memory; simulator restarts remain captured operational evidence. After the
last scheduled sample, the script waits out any remaining capture duration
before performing final validation.

Do not add an HPA or change requests and limits until the idle/1/2/3-user
measurements have been reviewed and the observed and selected values have been
documented. After that, follow the lab order: verify Metrics Server, add and
test the CPU HPA, then perform the VPA, capacity, and cost/performance work.
A headless Locust Job is only a possible future automation improvement; it is
not required for this manual sizing workflow.

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
`checkpoint-before-interruption.json` for the selected run. Autoscaling
evidence may contain a compatible `autoscaling-timeline.csv` with timestamp,
replica, request-rate, p95-latency, and failure columns. When optional evidence
is absent, the report shows explicit placeholders and does not invent values.

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
