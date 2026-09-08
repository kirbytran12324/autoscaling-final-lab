# Baseline Load Experiment

## Purpose

This experiment establishes the behavior of the simulator under sustained load when only one simulator replica is available. It is the baseline for evaluating whether autoscaling improves throughput, latency, availability, and workload stability.

## Test configuration

| Setting | Value |
| --- | --- |
| Simulator replicas | 1 |
| Concurrent users | 50 |
| User spawn rate | 5 users/second |
| Run duration | 3 minutes |
| Target endpoint | `POST /v1/battles` |

The measured Locust run started at `2026-09-04T10:04:57Z` and ended at `2026-09-04T10:07:57Z`. Cluster metrics were collected before, during, and shortly after that interval.

## Results

| Metric | Result |
| --- | --- |
| Total requests | 2,470 |
| Failed requests | 247 (10%) |
| Average throughput | 13.7 requests/second |
| Median latency (p50) | 1.5 seconds |
| p95 latency | 19 seconds |
| Simulator CPU | Reached the 500m CPU limit |
| Simulator restarts | 3 during the run |

The single replica was CPU-constrained under this workload. Simulator CPU repeatedly reached approximately `500m`, coinciding with degraded readiness and three restarts. With no additional replica available to absorb traffic, the run completed with a 10% failure rate and a long latency tail: although the median response took 1.5 seconds, 5% of responses took at least 19 seconds.

This result is the comparison point for later autoscaling experiments. An effective autoscaling configuration should keep more requests successful, reduce tail latency, and avoid restarts while sustaining at least the baseline offered load.

The [three-replica experiment](three-pod-experiment.md) repeats this load profile and includes a side-by-side comparison with the baseline.

## Supporting evidence

- [Locust HTML report](../evidence/experiments/single-pod-50-users/Locust_report.html) — request count, failures, throughput, and latency percentiles.
- [Replica observations](../evidence/experiments/single-pod-50-users/replicas.csv) — desired, current, ready, and available replica counts over time.
- [Resource observations](../evidence/experiments/single-pod-50-users/resources.csv) — CPU and memory samples for the simulator and load generator.
