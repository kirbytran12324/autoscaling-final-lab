# Phase 7 HPA autoscaling

Status: complete.

**Phase 7 HPA experiment: PASS**

This document is the canonical Phase 7 analysis and decision record. Raw
recorder artifacts and Locust HTML reports remain authoritative; every table
and conclusion below is derived from those files and does not replace them.

## Objective and acceptance boundary

Phase 7 validates CPU-driven horizontal autoscaling and the intended workload
boundaries:

- only the simulator Deployment is an HPA target;
- the tournament runner remains one singleton coordinator;
- Locust remains one fixed-replica load generator; and
- the ClusterIP Service routes connections to Ready simulator endpoints.

Acceptance requires useful scale-out under CPU load, traffic reaching every
new Ready replica, successful requests, and a safe return to the configured
minimum after load stops. It does not establish production availability or the
maximum capacity of six replicas.

## Accepted configuration

The final acceptance capture is
`phase7-hpa-3-users-150s-001`.

| Setting | Accepted value |
| --- | ---: |
| Capture duration | 600 seconds |
| Sampling interval | 15 seconds |
| Locust users | 3 |
| Locust spawn rate | 1 user/second |
| Locust load duration | 180 seconds |
| Simulator CPU request | 500m |
| Simulator CPU limit | 1000m |
| Simulator memory request | 192Mi |
| Simulator memory limit | 256Mi |
| HPA CPU target | 70% of request |
| Effective CPU target per Pod | approximately 350m |
| Minimum replicas | 1 |
| Maximum replicas | 6 |
| Scale-up stabilization | 0 seconds |
| Scale-down stabilization | 150 seconds |
| Locust replicas | 1, fixed |

The HPA target is relative to the CPU request:

```text
500m × 70% = 350m target CPU per Pod
```

The 1000m limit is a hard runtime ceiling, not the scaling target. A Pod can
remain below its limit while running above the utilization that asks the HPA
for another replica.

## Final acceptance capture

### Capture integrity

| Check | Verified result |
| --- | ---: |
| Capture status | `complete` |
| Scheduled samples | 40 |
| Successful samples | 40 |
| Failed samples | 0 |
| Final configuration validation | `ok` |
| Final artifact collection | `ok` |
| Worktree clean at capture start | Yes |
| Maximum desired replicas | 6 |
| Maximum Ready replicas | 6 |
| Final desired replicas | 1 |
| Final Ready replicas | 1 |
| Simulator container restarts | 0 |

The Deployment stable-spec identity, Service identity/spec, HPA identity/spec,
and simulator runtime-image identity remained compatible throughout. The
Locust Deployment, Pod UID, container ID, restart count, and runtime image also
remained unchanged. Locust stayed at one replica and was not an HPA target.

`experimentAcceptanceEvaluated: false` is intentional. The recorder verifies
collection and configuration integrity but does not decide whether the
experiment passed. This document performs that independent evaluation from the
captured timelines and Locust result.

### Scaling sequence and timing

The desired replica sequence derived from `hpa.csv` was:

```text
1 → 2 → 3 → 5 → 6 → 4 → 1
```

| HPA observation | Desired replicas | Next observed Ready replicas |
| --- | ---: | ---: |
| `15:51:26Z` | 1 | 1 |
| `15:52:26Z` | 2 | 2 at `15:52:27Z` |
| `15:52:42Z` | 3 | 3 at `15:52:42Z` |
| `15:53:11Z` | 5 | 5 at `15:53:11Z` |
| `15:53:57Z` | 6 | 6 at `15:53:57Z` |
| `15:57:41Z` | 4 | 4 at `15:57:42Z` |
| `15:57:56Z` | 1 | 1 at `15:57:57Z` |

Load began at approximately `2026-09-13T15:51:50Z`. Six Ready replicas were
observed at `15:53:57Z`, so scale-out from load start to six Ready replicas took
approximately 127 seconds. This includes Metrics Server collection, HPA
reconciliation, Pod creation, and readiness.

Load stopped at approximately `15:54:50Z`. The first recorded scale-in was the
HPA change from six desired replicas to four at `15:57:41Z`, approximately 171
seconds later. The Deployment returned to one desired and one Ready replica at
approximately `15:57:57Z`, 187 seconds after load stopped.

These delays exceed exactly 150 seconds because the stabilization window acts
on HPA recommendations, while controller reconciliation and the recorder both
observe state on discrete intervals. The CSV timestamps therefore bound an
observed action rather than measuring a continuous control loop.

The earlier 300-second-window experiment first scaled in approximately 313
seconds after load stopped. The accepted 150-second configuration reduced the
observed delay to first scale-in by approximately 142 seconds, about 45%, while
still avoiding premature scale-down during the load interval.

Ready EndpointSlice membership followed the Deployment at every observed
transition: 1, 2, 3, 5, 6, 4, and finally 1 Ready backend. The one-second
difference at some transitions is normal collection ordering within a sample.

### Locust result

| Metric | Verified result |
| --- | ---: |
| Requests | 13,033 |
| Failures | 0 |
| Failure rate | 0% |
| Average RPS | 72.42 |
| Average response time | 41.02 ms |
| Median response time | 33 ms |
| p95 response time | 95 ms |
| p99 response time | 160 ms |
| Maximum response time | 949 ms |

The 72.42 RPS average covers the initial one-Pod period and live scale-out. It
is not directly comparable to a capacity run that begins only after all six
Pods are Ready.

### Service traffic distribution

The final `servedBy` summary contains six distinct simulator Pods:

| Simulator Pod suffix | Successful requests |
| --- | ---: |
| `7l7fz` | 4,040 |
| `cbq76` | 1,648 |
| `d7tpc` | 2,235 |
| `lnl6n` | 1,601 |
| `lttjx` | 817 |
| `r7nlc` | 2,692 |
| **Total** | **13,033** |

The counts reconcile exactly with Locust's 13,033-request total. Every named
Pod appears in `pods.csv` and was observed as a Ready EndpointSlice target.
This resolves the earlier persistent-connection problem: all six replicas
demonstrably served traffic. Distribution was not perfectly even, and no such
claim is made. A Kubernetes Service routes connections rather than strictly
round-robin scheduling individual requests; the original Pod also served the
one-Pod opening period.

## Three distinct Phase 7 experiment groups

The following evidence has different purposes and must not be combined as if
it came from one run.

### 1. Exploratory six-replica capacity sweep

After six replicas were already Ready, sequential exploratory runs used 3, 6,
9, and 12 Locust users. The 3-user run lasted approximately 59 seconds and the
remaining runs approximately 90 seconds. These describe the capacity curve;
they are not the formal Phase 7 acceptance capture.

| Users | Requests | RPS | Gain from prior run | Average | Median | p95 | p99 | Failures |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | 4,782 | 81.34 | - | 36.69 ms | 32 ms | 73 ms | 120 ms | 0 |
| 6 | 9,102 | 101.17 | +24.4% | 59.02 ms | 47 ms | 140 ms | 230 ms | 0 |
| 9 | 10,105 | 112.31 | +11.0% | 79.74 ms | 62 ms | 200 ms | 300 ms | 0 |
| 12 | 11,058 | 122.88 | +9.4% | 97.29 ms | 77 ms | 240 ms | 340 ms | 0 |

Throughput continued to rise, but each concurrency increase produced smaller
returns. From 3 to 12 users, offered concurrency increased 300% while RPS
increased about 51%; average latency increased about 165%, and p95 increased
about 229%. Every run had zero failed requests.

This matches a closed-loop generator: each user waits for its current request
before sending another. For the 12-user run:

```text
12 users ÷ 0.09729 seconds average response time = 123.34 requests/second
observed result = 122.88 requests/second
```

Instantaneous Kubernetes Dashboard observations showed increasing simulator
and Locust CPU consumption:

| Users | Average simulator CPU/Pod | Highest simulator CPU | Locust CPU | Highest simulator memory |
| ---: | ---: | ---: | ---: | ---: |
| 3 | 404m | 452m | 271m | 172Mi |
| 6 | 590m | 638m | 357m | 172Mi |
| 9 | 723m | 772m | 441m | 172Mi |
| 12 | 775m | 839m | 476m | 173Mi |

These are not time-series averages. They show diminishing throughput returns,
increasing latency, and growing Locust CPU use, but do not rule out brief
throttling or node pressure. Simulator Pods remained below their 1000m CPU
limit even though they were well above the HPA's 350m target. At 12 users, the
six-replica maximum prevented the HPA from satisfying its uncapped
recommendation.

### 2. Earlier 300-second-window HPA capture

Experiment `phase7-hpa-3-users-001` used three users, a 180-second load, a
600-second capture, and a 300-second scale-down stabilization window. It
successfully scaled from one to six replicas, had 10,057 requests and zero
failures, and proved that all six Ready Pods served traffic. Its first
scale-in occurred approximately 313 seconds after load stopped, but the
capture ended with two desired and two Ready replicas. It therefore remains
valuable historical scale-out evidence, not the final acceptance run.

### 3. Final 150-second-window acceptance capture

Experiment `phase7-hpa-3-users-150s-001` repeated the three-user profile with
the tuned 150-second scale-down window. It completed the full lifecycle from
one to six and back to one, with all six Pods serving requests and no failures
or restarts. This is the formal acceptance run used for the Phase 7 verdict.

## Acceptance conclusion

**Phase 7 HPA experiment: PASS**

The evidence supports the verdict because:

- CPU load scaled the simulator Deployment from one to six replicas;
- every replica became Ready and received traffic;
- all 13,033 requests completed with zero Locust failures;
- the Deployment safely returned to one replica after load ended;
- the 150-second scale-down window materially improved recovery compared with
  the earlier 300-second configuration;
- only simulator Pods autoscaled, while Locust remained one fixed replica; and
- no restart, configuration drift, or runtime-image drift invalidated the run.

## Limitations

- This is a local multi-node Kubernetes lab, not a production benchmark.
- One experiment does not establish statistical confidence.
- HPA metrics, controller actions, readiness, and recorder samples occur at
  discrete intervals.
- The average Locust result includes one-Pod startup and scale-out effects.
- Request distribution across Pods was demonstrably broad but uneven.
- The run validates CPU-driven autoscaling and Service routing, not maximum
  six-Pod capacity or production availability.
- The HPA reached `maxReplicas: 6`; higher unresolved load requires a larger
  maximum, different resource settings, or another scaling strategy.

## Evidence links and later curation

Essential authoritative artifacts for a later commit are:

- [capture-status.json](../evidence/experiments/phase7-hpa-3-users-150s-001/capture-status.json)
  and [metadata.json](../evidence/experiments/phase7-hpa-3-users-150s-001/metadata.json);
- [hpa.csv](../evidence/experiments/phase7-hpa-3-users-150s-001/hpa.csv),
  [replicas.csv](../evidence/experiments/phase7-hpa-3-users-150s-001/replicas.csv),
  [pods.csv](../evidence/experiments/phase7-hpa-3-users-150s-001/pods.csv),
  [endpoints.csv](../evidence/experiments/phase7-hpa-3-users-150s-001/endpoints.csv),
  and [sample-status.csv](../evidence/experiments/phase7-hpa-3-users-150s-001/sample-status.csv);
- [locust.log](../evidence/experiments/phase7-hpa-3-users-150s-001/locust.log)
  and the [Locust HTML report](../evidence/experiments/phase7-hpa-3-users-150s-001/locust_report.html).

Useful supporting diagnostics are
[served-by-summary.txt](../evidence/experiments/phase7-hpa-3-users-150s-001/served-by-summary.txt)
and [hpa-events.json](../evidence/experiments/phase7-hpa-3-users-150s-001/hpa-events.json).
The summary duplicates a line retained in `locust.log`. Excluding it would
remove convenience, not authority. Excluding HPA events would remove exact
controller event messages and event timestamps, while the CSVs would still
preserve observed replica transitions.

The broad namespace event dump and duplicate start/end object snapshots are
high-volume or redundant raw diagnostics. They should remain untouched in the
local complete capture. A later curated commit may exclude them because
`metadata.json`, `capture-status.json`, and the core timelines preserve the
accepted facts; doing so would reduce forensic detail for unrelated namespace
events and full raw object comparisons. No curation is performed here.
