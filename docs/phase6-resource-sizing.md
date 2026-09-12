# Phase 6 resource sizing

Status: complete.

This document is the canonical Phase 6 analysis and decision record. The
captured CSV/JSON artifacts and per-run Locust HTML reports remain the
authoritative measurement evidence. Phase 6 measured one fixed simulator Pod
before introducing a Horizontal Pod Autoscaler (HPA). Locust remained at one
fixed replica, Metrics Server supplied Kubernetes CPU and memory observations,
and cgroup counters supplied CPU-throttling evidence. The observed results were
used to select simulator requests and limits. These runs did not include or
demonstrate autoscaling.

## Experiment method

| Parameter | Value |
| --- | ---: |
| Simulator replicas | 1 |
| Locust replicas | 1 |
| HPA present | No |
| Kubernetes capture | 240 seconds |
| Sampling interval | 15 seconds |
| Locust load duration | 180 seconds |
| Locust wait time | 0 |
| Initial profiles | Idle, 1, 2, and 3 users |
| Validation profile | 1 user, spawn rate 1 |

Locust users represent concurrent requests, not a requested request rate. With
zero wait time, each virtual user sent its next request as soon as the prior
request completed. RPS was therefore an observed outcome rather than a load
input.

## Original resource configuration

| Resource | Request | Limit |
| --- | ---: | ---: |
| CPU | 100m | 500m |
| Memory | 128Mi | 512Mi |

## Original load-test results

| Users | Requests | RPS | Average | Median | p95 | p99 | Failures |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 3,638 | 20.21 | 49 ms | 27 ms | 110 ms | 200 ms | 0 |
| 2 | 4,053 | 22.53 | 89 ms | 88 ms | 190 ms | 280 ms | 0 |
| 3 | 4,304 | 23.91 | 125 ms | 110 ms | 280 ms | 390 ms | 0 |

One user already saturated the 500m CPU limit. Moving from one to two users
added 11% throughput but approximately 80% average latency. Moving from two to
three users added only another 6% throughput but another 41% average latency.
Overload appeared as latency and queuing rather than request failures.

## Original resource observations

| Profile | Median CPU | Peak CPU | Peak memory | Throttled periods |
| --- | ---: | ---: | ---: | ---: |
| Idle | 2m | 5m | 133Mi | 0% |
| 1 user | 500m | 501m | 178Mi | 98.3% |
| 2 users | 500m | 501m | 168Mi | 95.8% |
| 3 users | 499.5m | 501m | 166Mi | 94.8% |

The 500m CPU limit was binding, and the 100m CPU request substantially
understated loaded consumption. The 128Mi memory request was below even the
133Mi idle observation. Locust remained below its limits and was not the
bottleneck.

## Selected configuration

| Resource | Request | Limit |
| --- | ---: | ---: |
| CPU | 500m | 1 CPU |
| Memory | 192Mi | 256Mi |

The values have the following observed basis:

- The `500m` CPU request matches the original observed CPU ceiling and provides
  an HPA-oriented reserved baseline.
- The `1 CPU` limit gives the single Node.js process access to one full core.
- The `192Mi` memory request rounds the observed 178Mi peak upward.
- The `256Mi` memory limit provides 76Mi, or about 42%, above the subsequently
  observed 180Mi validation peak.

## Matched validation comparison

The original and selected configurations were compared under the same
one-user, spawn-rate-one, 180-second Locust profile.

| Metric | Original | Selected configuration | Change |
| --- | ---: | ---: | ---: |
| Requests | 3,638 | 9,322 | +156% |
| Throughput | 20.21 RPS | 51.80 RPS | +156% |
| Average latency | 49.3 ms | 19.2 ms | -61% |
| Median latency | 27 ms | 17 ms | -37% |
| p95 latency | 110 ms | 36 ms | -67% |
| p99 latency | 200 ms | 68 ms | -66% |
| Failures | 0 | 0 | Unchanged |
| Median CPU | 500m | 955m | +91% productive usage |
| Throttled periods | 98.3% | 17.0% | -81.3 percentage points |
| Throttled time | 113.2s | 12.0s | -89% |
| Peak memory | 178Mi | 180Mi | +2Mi |
| Restarts | 0 | 0 | Unchanged |

Higher CPU usage is expected and desirable: the former limit prevented useful
processing. The simulator used approximately 111% more mean CPU while
completing 156% more work, so approximate CPU consumed per request improved by
about 18%. The process productively used nearly one full core, while memory
remained stable despite the throughput increase.

The remaining 17% throttled periods must also be recorded honestly. The
one-core limit is still a real ceiling. Horizontal scaling is the intended
response to additional demand rather than continually increasing the Pod
size.

## Requests, limits, and the HPA

CPU requests reserve scheduling capacity. CPU limits cap runtime CPU
consumption. For a resource-utilization HPA, CPU utilization is calculated
relative to the CPU request, not the CPU limit. Loaded mean CPU under the
selected configuration was approximately:

```text
909.5m ÷ 500m = 181.9% utilization
```

If Phase 7 selects a 70% CPU target, the initial one-replica approximation
would be:

```text
ceil(181.9% ÷ 70%) = approximately 3 replicas
```

The 70% value is only a Phase 7 candidate; it is not an accepted target. The
`500m` request is likewise an HPA-oriented hypothesis. It does not match the
saturated single-Pod consumption of approximately 910-955m. Phase 7 must
validate that this denominator and the eventual target produce sensible
scale-out and scale-in behaviour.

## Evidence integrity and limitations

All five captures completed with 16 samples. Final validation was `ok`, with
no failed samples or warnings. The simulator remained Running and Ready,
replica counts remained one, and no restart-count changes occurred during the
captures. Locust remained the same Pod and container throughout each
experiment.

Each concurrency was tested once, so run-to-run variance is unavailable. The
original matrix used a simulator Pod on `desktop-worker2`. Applying the new
resource configuration necessarily rolled out a replacement simulator Pod,
which ran on `desktop-worker` for the selected-configuration validation. The
simulator image digest was identical and Locust retained the same Pod and
container, but the different simulator node is a possible minor confounder.
Because the tests were sequential, warm-up or Node.js JIT effects may also
influence small differences. The selected configuration received a matched
one-user validation; the entire idle/one/two/three-user matrix was not
repeated.

### Known labeling exception

The evidence directory `phase6-2-user-001` incorrectly records
`phase6-1-user-001` as its internal experiment ID. Its Locust report confirms
that two users actually ran. The original evidence is intentionally preserved
unchanged; this is a known metadata-labeling mistake, not reconstructed
evidence.

### Locust export policy

The per-run HTML report is sufficient when it contains request totals, RPS,
failures, latency percentiles, user history, and timestamps. CSV exports are
optional supporting evidence, not mandatory evidence. Missing raw CSV exports
must not be reconstructed from HTML and represented as original exports.

## Evidence links

Each directory contains immutable metadata, capture outcome, sampled
resources, replica state, simulator Pod health, cgroup throttling counters,
and per-sample status. Load-run directories also contain the per-run Locust
HTML report.

### `phase6-idle-001`

- [metadata.json](../evidence/experiments/phase6-idle-001/metadata.json)
- [capture-status.json](../evidence/experiments/phase6-idle-001/capture-status.json)
- [resources.csv](../evidence/experiments/phase6-idle-001/resources.csv)
- [replicas.csv](../evidence/experiments/phase6-idle-001/replicas.csv)
- [simulator-pods.csv](../evidence/experiments/phase6-idle-001/simulator-pods.csv)
- [simulator-throttling.csv](../evidence/experiments/phase6-idle-001/simulator-throttling.csv)
- [sample-status.csv](../evidence/experiments/phase6-idle-001/sample-status.csv)

### `phase6-1-user-001`

- [metadata.json](../evidence/experiments/phase6-1-user-001/metadata.json)
- [capture-status.json](../evidence/experiments/phase6-1-user-001/capture-status.json)
- [resources.csv](../evidence/experiments/phase6-1-user-001/resources.csv)
- [replicas.csv](../evidence/experiments/phase6-1-user-001/replicas.csv)
- [simulator-pods.csv](../evidence/experiments/phase6-1-user-001/simulator-pods.csv)
- [simulator-throttling.csv](../evidence/experiments/phase6-1-user-001/simulator-throttling.csv)
- [sample-status.csv](../evidence/experiments/phase6-1-user-001/sample-status.csv)
- [locust_report.html](../evidence/experiments/phase6-1-user-001/locust_report.html)

### `phase6-2-user-001`

- [metadata.json](../evidence/experiments/phase6-2-user-001/metadata.json)
- [capture-status.json](../evidence/experiments/phase6-2-user-001/capture-status.json)
- [resources.csv](../evidence/experiments/phase6-2-user-001/resources.csv)
- [replicas.csv](../evidence/experiments/phase6-2-user-001/replicas.csv)
- [simulator-pods.csv](../evidence/experiments/phase6-2-user-001/simulator-pods.csv)
- [simulator-throttling.csv](../evidence/experiments/phase6-2-user-001/simulator-throttling.csv)
- [sample-status.csv](../evidence/experiments/phase6-2-user-001/sample-status.csv)
- [locust_report.html](../evidence/experiments/phase6-2-user-001/locust_report.html)

### `phase6-3-user-001`

- [metadata.json](../evidence/experiments/phase6-3-user-001/metadata.json)
- [capture-status.json](../evidence/experiments/phase6-3-user-001/capture-status.json)
- [resources.csv](../evidence/experiments/phase6-3-user-001/resources.csv)
- [replicas.csv](../evidence/experiments/phase6-3-user-001/replicas.csv)
- [simulator-pods.csv](../evidence/experiments/phase6-3-user-001/simulator-pods.csv)
- [simulator-throttling.csv](../evidence/experiments/phase6-3-user-001/simulator-throttling.csv)
- [sample-status.csv](../evidence/experiments/phase6-3-user-001/sample-status.csv)
- [locust_report.html](../evidence/experiments/phase6-3-user-001/locust_report.html)

### `phase6-1-user-rightsized-001`

- [metadata.json](../evidence/experiments/phase6-1-user-rightsized-001/metadata.json)
- [capture-status.json](../evidence/experiments/phase6-1-user-rightsized-001/capture-status.json)
- [resources.csv](../evidence/experiments/phase6-1-user-rightsized-001/resources.csv)
- [replicas.csv](../evidence/experiments/phase6-1-user-rightsized-001/replicas.csv)
- [simulator-pods.csv](../evidence/experiments/phase6-1-user-rightsized-001/simulator-pods.csv)
- [simulator-throttling.csv](../evidence/experiments/phase6-1-user-rightsized-001/simulator-throttling.csv)
- [sample-status.csv](../evidence/experiments/phase6-1-user-rightsized-001/sample-status.csv)
- [locust_report.html](../evidence/experiments/phase6-1-user-rightsized-001/locust_report.html)

## Conclusion

> The selected configuration removes the severe CPU restriction, increases
> useful throughput by 156%, reduces p95 latency by 67%, and retains stable
> memory and Pod health. The CPU limit and memory values are accepted. The
> 500m CPU request is accepted as the starting HPA baseline and must be
> validated through Phase 7 scale-out and scale-in testing.
