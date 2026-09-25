# Three-Replica Load Experiment

Status: historical pre-HPA exploratory experiment. Its findings informed the
later controlled Phase 6 sizing and Phase 7 HPA work; the follow-up items below
record what was unresolved at the time rather than current assignment gaps.

## Technical summary

Running the same load profile against three simulator replicas increased average throughput from 13.7 to 37.7 requests/second while reducing the failure rate from 10.0% to 2.1%. Median latency fell from 1.5 seconds to 790 milliseconds, and p95 latency fell from 19 seconds to 2.2 seconds.

The additional replicas substantially improved capacity and tail latency, but they did not eliminate resource pressure. All three simulator pods reached their `500m` per-pod CPU limit, and ready capacity degraded during the run. The result demonstrates a clear improvement over the single-replica baseline, but not a fully stable operating point.

## Test configuration

| Setting | Value |
| --- | --- |
| Simulator replicas | 3 |
| Concurrent users | 50 |
| User spawn rate | 5 users/second |
| Run duration | 3 minutes |
| Target endpoint | `POST /v1/battles` |

The measured Locust run started at `2026-09-08T02:23:54Z` and ended at `2026-09-08T02:26:54Z`. Cluster metrics were collected before, during, and shortly after that interval.

## Results

| Metric | Result |
| --- | --- |
| Total requests | 6,795 |
| Failed requests | 141 (2.1%) |
| Average throughput | 37.7 requests/second |
| Median latency (p50) | 790 milliseconds |
| p95 latency | 2.2 seconds |
| Simulator CPU | All three pods reached the 500m per-pod limit |
| Replica health | Ready replicas fell from 3 to 0, recovered to 3, then fell to 1 |

Locust recorded 2.75 times as many request completions per second, while the failure rate decreased from 10.0% to 2.1%. However, the resource samples show repeated CPU saturation across the pods. The replica samples also show that the Deployment continued to report three desired and current replicas while its ready and available counts dropped, indicating that configured replica count alone did not guarantee healthy serving capacity.

## Comparison with the single-replica baseline

Both experiments used 50 concurrent users, a spawn rate of 5 users/second, a three-minute run, and the same endpoint. The comparison is therefore useful as a descriptive measure of the observed difference associated with adding two simulator replicas.

| Metric | 1 replica | 3 replicas | Change |
| --- | ---: | ---: | ---: |
| Total requests | 2,470 | 6,795 | +4,325 (+175%) |
| Failed requests | 247 | 141 | -106 |
| Failure rate | 10.0% | 2.1% | -7.9 percentage points (-79% relative) |
| Average throughput | 13.7 RPS | 37.7 RPS | +24.0 RPS (+175%, 2.75x) |
| Median latency (p50) | 1.5 s | 0.79 s | -0.71 s (-47%) |
| p95 latency | 19.0 s | 2.2 s | -16.8 s (-88%) |
| CPU behavior | One pod reached 500m | All three pods reached 500m each | More aggregate capacity, same per-pod saturation |

The strongest improvement was in tail latency: p95 decreased by 88%. The lower failure rate and higher throughput show that the three-replica run was much more resilient under this load. Because every replica still reached its CPU limit and healthy capacity declined, three fixed replicas should be treated as an improved comparison point rather than evidence that the workload has sufficient headroom.

## Historical limitations and follow-up

- These are two separate runs on different dates, with one observation per configuration. The results are descriptive and do not isolate every possible environmental difference.
- The replica CSV records desired, current, ready, and available counts, but not container restart counters. It supports the observed readiness degradation, not an exact restart count for the three-replica run.
- Repeated configurations would have measured run-to-run variation.
- Phase 7 later tested autoscaling beyond three replicas and reconciled Ready
  Pods, EndpointSlices, and reported response hostnames.
- Phase 7 also captured container restart counts and events alongside resource
  and replica samples.

## Supporting evidence

- [Three-replica Locust HTML report](../evidence/experiments/three-pod-50-users/Locust_report.html) — request count, failures, throughput, and latency percentiles.
- [Three-replica observations](../evidence/experiments/three-pod-50-users/replicas.csv) — desired, current, ready, and available replica counts over time.
- [Three-replica resource observations](../evidence/experiments/three-pod-50-users/resources.csv) — CPU and memory samples for each simulator pod and the load generator.
- [Single-replica baseline](baseline-experiment.md) — baseline results and links to its corresponding evidence.
