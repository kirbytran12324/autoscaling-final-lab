# Phase 7 HPA autoscaling

Status: in progress. Scale-out and Service distribution are verified. Final
acceptance remains pending a capture that returns the simulator Deployment to
its one-replica minimum after load stops.

This document is the canonical Phase 7 analysis and decision record. Raw
capture artifacts and Locust HTML reports remain the authoritative
measurement evidence. Tables and conclusions here are derived from those
artifacts and must not be represented as replacement raw exports.

## Objective

Phase 7 validates that CPU-driven horizontal autoscaling improves the
simulator's ability to serve load while preserving the intended workload
boundaries:

- only the simulator Deployment is an HPA target;
- the tournament runner remains one singleton coordinator;
- Locust remains one fixed-replica load generator; and
- the ClusterIP Service routes connections to Ready simulator endpoints.

Acceptance requires both directions of scaling: the simulator must scale out
under load and return to its configured minimum after the load stops.

## Tested configuration

| Setting | Initial Phase 7 value |
| --- | ---: |
| Simulator CPU request | 500m |
| Simulator CPU limit | 1 CPU |
| Simulator memory request | 192Mi |
| Simulator memory limit | 256Mi |
| HPA CPU target | 70% of request |
| Effective CPU target per Pod | 350m |
| Minimum replicas | 1 |
| Maximum replicas | 6 |
| Scale-up stabilization | 0 seconds |
| Scale-down stabilization | 300 seconds |
| Locust replicas | 1, fixed |

The HPA target is relative to the `500m` CPU request:

```text
500m × 70% = 350m target CPU per Pod
```

The `1 CPU` limit is a hard runtime ceiling, not the HPA target. A Pod can
remain below its limit while already running well above the utilization that
asks the HPA for another replica.

## Initial formal capture

Experiment `phase7-hpa-3-users-001` used three Locust users, spawn rate one,
a 180-second load interval, a 600-second Kubernetes capture, and a 15-second
sampling interval. Locust users ran with zero wait time, so RPS was an observed
result rather than a configured request rate.

### Collection integrity

| Check | Result |
| --- | ---: |
| Capture status | Complete |
| Samples | 40 |
| Successful samples | 40 |
| Failed samples | 0 |
| Final configuration validation | OK |
| Final artifact collection | OK |
| Worktree clean at capture start | Yes |
| Maximum desired replicas | 6 |
| Maximum Ready replicas | 6 |
| Replicas at capture end | 2 |

`complete` describes evidence collection, not experiment acceptance. The run
did not observe the Deployment returning to `minReplicas: 1`, so it is not the
final Phase 7 acceptance run.

### Scale-out and scale-in observations

Load began at approximately `14:40:01Z`. The HPA first requested two replicas
at `14:40:29Z`, requested six by `14:41:29Z`, and six simulator Pods were
available at approximately `14:41:43Z`. Scale-out to the configured maximum
therefore took about 102 seconds from load start, including Metrics Server,
HPA reconciliation, Pod creation, and readiness delay.

Load stopped at approximately `14:43:01Z`. The first recorded scale-in action
reduced the desired count from six to two at `14:48:14Z`, about 313 seconds
after load stopped. The capture ended at `14:49:15Z` with two current and two
desired replicas. This result supports reducing the scale-down stabilization
window or extending the final capture, but does not by itself establish that
the Deployment returned to one replica.

### Load-test result

| Metric | Result |
| --- | ---: |
| Users | 3 |
| Requests | 10,057 |
| Failures | 0 |
| Failure rate | 0% |
| Overall RPS | 55.88 |
| Average latency | 53.17 ms |
| Median latency | 42 ms |
| p95 latency | 130 ms |
| p99 latency | 220 ms |
| Maximum latency | 1,389 ms |

The overall RPS includes the scale-out period. After six replicas became
Ready, five-second Locust samples were generally about 70-84 RPS. This is a
derived steady-state observation rather than a separate Locust export.

### Service distribution

Locust's `servedBy` summary recorded successful responses from all six
simulator Pods:

| Simulator Pod suffix | Successful responses |
| --- | ---: |
| `59jkp` | 1,780 |
| `9vct6` | 1,331 |
| `kv4nn` | 1,504 |
| `mztkx` | 1,046 |
| `r9sjf` | 3,101 |
| `wmhfh` | 1,295 |
| **Total** | **10,057** |

The original Pod, `r9sjf`, served traffic before replacement Pods became
Ready, so whole-run counts are not a steady-state load-balancing fairness
measurement. The important verified result is that all six Ready Service
backends served successful requests. A Kubernetes Service distributes
connections; it does not promise equal request counts per Pod.

## Exploratory six-replica capacity sweep

After the Deployment had reached six Ready replicas, sequential exploratory
runs used 3, 6, 9, and 12 Locust users. The 3-user run lasted approximately 59
seconds and the remaining runs approximately 90 seconds. These results are
useful for explaining the capacity curve, but they are not substitutes for
the final scale-out and scale-in acceptance capture.

| Users | Requests | RPS | Gain from prior run | Average | Median | p95 | p99 | Failures |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | 4,782 | 81.34 | - | 36.69 ms | 32 ms | 73 ms | 120 ms | 0 |
| 6 | 9,102 | 101.17 | +24.4% | 59.02 ms | 47 ms | 140 ms | 230 ms | 0 |
| 9 | 10,105 | 112.31 | +11.0% | 79.74 ms | 62 ms | 200 ms | 300 ms | 0 |
| 12 | 11,058 | 122.88 | +9.4% | 97.29 ms | 77 ms | 240 ms | 340 ms | 0 |

Throughput continued to rise, but additional concurrency produced diminishing
returns. From 3 to 12 users, offered concurrency increased by 300% while RPS
increased by about 51%. Average latency increased by about 165%, and p95
latency increased by about 229%. There was no hard failure cliff: every run
completed with zero failed requests.

This is consistent with a closed-loop load generator. Each Locust user waits
for its current request to finish before sending its next request. For
example, the 12-user result is approximately reconciled by:

```text
12 users ÷ 0.09729 seconds average response time = 123.34 requests/second
observed result = 122.88 requests/second
```

The close agreement shows that higher response time directly constrained the
throughput produced by the fixed user count.

## Exploratory resource observations

The following values are instantaneous Kubernetes Dashboard samples taken
during the four sequential runs. They are not time-series averages and cannot
prove the absence of short CPU-throttling or node-pressure events.

| Users | Average simulator CPU/Pod | Highest simulator CPU | Locust CPU | Highest simulator memory |
| ---: | ---: | ---: | ---: | ---: |
| 3 | 404m | 452m | 271m | 172Mi |
| 6 | 590m | 638m | 357m | 172Mi |
| 9 | 723m | 772m | 441m | 172Mi |
| 12 | 775m | 839m | 476m | 173Mi |

The observations do not identify Locust or memory as the first limiting
resource. Locust remained below half of its one-core limit. Simulator memory
remained below the `256Mi` limit and changed little as users increased.

At 12 users, average simulator CPU was approximately `775m`, or 155% of the
`500m` request. If that instantaneous observation matched an HPA sample, the
uncapped replica recommendation would be approximately:

```text
ceil(6 current replicas × 155% current utilization ÷ 70% target) = 14 replicas
```

The configured maximum of six prevents that recommendation from being
satisfied. The resulting latency growth is therefore compatible with normal
queueing above the HPA target even though no Pod reached its `1 CPU` hard
limit. Per-request connection creation, used to avoid persistent-connection
pinning to one Service backend, is also a plausible source of overhead. The
current evidence does not isolate its contribution.

## Interpretation

Verified conclusions:

- CPU load caused the HPA to scale the simulator from one to six replicas.
- All six Ready simulator Pods served successful requests through the
  ClusterIP Service.
- Throughput increased under higher concurrency without request failures.
- Latency and resource usage increased as concurrency rose.
- Locust remained one fixed replica and was not an HPA target.
- The initial 600-second capture did not record a full return to one replica.

Supported but not isolated explanations:

- the six-replica cap prevented the HPA from restoring the 350m-per-Pod target
  under the higher exploratory loads;
- queueing increased as per-Pod CPU utilization rose; and
- opening a new connection for every request added work while enabling
  distribution across Service endpoints.

Node CPU pressure and cgroup throttling were not captured during the
exploratory sweep. They remain possible contributors and must not be described
as ruled out.

## Final acceptance requirements

The replacement formal capture must establish all of the following before
Phase 7 is marked complete:

- collection status is `complete`, final validation is `ok`, and no required
  sample failed;
- the simulator starts at one Ready replica;
- CPU load produces more than one desired and Ready simulator replica;
- new Ready Pods appear as Service endpoints;
- successful `servedBy` results include multiple simulator Pod identities;
- Locust remains one fixed Pod and the same container lifetime throughout;
- request totals, RPS, failures, average latency, p95, and p99 are recorded;
- load stop time and scale-in timing are recorded;
- the Deployment returns to one desired and one Ready replica before capture
  ends; and
- simulator, Service, HPA, Locust, and runtime-image identities remain valid.

The final report must state the accepted scale-down stabilization window and
explain why it balances recovery speed against replica churn. It must also
distinguish the HPA's 350m operating target from the one-core Pod limit.

## Evidence policy

Preserve the complete recorder output locally, but commit only the useful
audit set:

- `capture-status.json` and `metadata.json`;
- `hpa.csv`, `replicas.csv`, `pods.csv`, `endpoints.csv`, and
  `sample-status.csv`;
- `locust.log` and the Locust HTML report; and
- `hpa-events.json` when it contains useful scaling events.

Broad namespace events and duplicate start/end snapshots are not needed when
the curated files preserve the same facts. The capacity table is derived from
the four supplied Locust HTML reports and four instantaneous resource
screenshots; it must not be presented as an original CSV export.

## Pending final update

After the tuned scale-down capture completes, replace the provisional values
with the accepted experiment ID, HPA fingerprint and configuration, scale-out
and scale-in timings, final replica count, Locust result, Service distribution,
and evidence links. Only then change this status and the repository phase
status to complete.
