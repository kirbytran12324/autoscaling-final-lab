# Phase 8 VPA recommendation comparison

## Purpose

This experiment compares Vertical Pod Autoscaler (VPA) recommendations with
the simulator resources selected manually in Phase 6. It also verifies that
recommendation-only mode leaves the Deployment unchanged and records why an
automatic CPU VPA is not combined with the simulator's CPU-utilization HPA.

## Configuration

The cluster used VPA `v1.7.1`, built from upstream revision
`352365899477910018f40d89fa3ea30b2c5d0e78`. The committed
[VPA manifest](../k8s/vpa/vertical-pod-autoscaler.yaml) targets the `simulator`
container and observes CPU and memory with `controlledValues: RequestsOnly`.
Its `updateMode: "Off"` makes recommendations but does not update Pod requests
or restart Pods.

The simulator retained the Phase 6 resource configuration throughout the
experiment:

| Resource | Request | Limit |
| --- | ---: | ---: |
| CPU | 500m | 1000m |
| Memory | 192Mi | 256Mi |

The captured [VPA component images](../evidence/experiments/phase8-vpa-001/vpa-components.txt),
[version](../evidence/experiments/phase8-vpa-001/vpa-upstream-version.txt),
[upstream revision](../evidence/experiments/phase8-vpa-001/vpa-upstream-revision.txt),
and [registered API resources](../evidence/experiments/phase8-vpa-001/vpa-api-resources.txt)
identify the installed implementation. The
[captured Git revision](../evidence/experiments/phase8-vpa-001/git-revision.txt)
identifies the committed manifest used by the experiment.

## Experiment timeline

The primary observation log records the initial, loaded, and end-of-load
snapshots in one [command transcript](../evidence/experiments/phase8-vpa-001/loaded_observations.txt).
Later authoritative VPA objects capture the
[post-scale-in state](../evidence/experiments/phase8-vpa-001/vpa-idle-after-scale-in.yaml)
and [recovery state](../evidence/experiments/phase8-vpa-001/vpa-recovery.yaml).

| State | Local time | CPU lower | CPU target | CPU upper | Observed CPU |
| --- | --- | ---: | ---: | ---: | --- |
| Initial idle | 09:42:38 | 25m | 25m | 2007m | 1m |
| Loaded | 09:48:12 | 386m | 548m | 84421m | 361–407m/Pod |
| Loaded | 09:53:59 | 411m | 511m | 41683m | 376–420m/Pod |
| End of load | 09:58:03 | 421m | 511m | 34586m | 366–419m/Pod |
| After scale-in | 10:08:12 | 405m | 511m | 22775m | 1m |
| Recovery | 10:12:25 | 410m | 511m | 19849m | 1m |

All times are on 2026-09-14 in Asia/Bangkok (`UTC+07:00`). The separate
[post-scale-in timestamp](../evidence/experiments/phase8-vpa-001/idle-after-scale-in-timestamp.txt)
and [top capture](../evidence/experiments/phase8-vpa-001/simulator-top-idle-after-scale-in.txt),
plus the [recovery timestamp](../evidence/experiments/phase8-vpa-001/recovery-timestamp.txt)
and [top capture](../evidence/experiments/phase8-vpa-001/simulator-top-recovery.txt),
anchor the last two rows. The
[post-scale-in resource snapshot](../evidence/experiments/phase8-vpa-001/resources-idle-after-scale-in.json)
and [recovery Deployment resource snapshot](../evidence/experiments/phase8-vpa-001/deployment-resources-recovery.json)
confirm that the configured requests and limits did not change.

The [Locust report](../evidence/experiments/phase8-vpa-001/locust_report.html)
covers approximately 09:43:06–09:58:06 local time. Three users completed
78,608 requests with zero failures, 87.34 average RPS, 34.14 ms average
latency, 72 ms p95, and 120 ms p99.

## Comparison and interpretation

| Resource | Manual request | Settled VPA target | Interpretation |
| --- | ---: | ---: | --- |
| CPU | 500m | 511m | VPA is 11m, or 2.2%, above the selected request. |
| Memory | 192Mi | 250Mi | The recommendation equals the recommender's default minimum and is not an observed application requirement. |

The settled `511m` CPU target independently supports the manually selected
`500m` request. A difference of `11m` is not material enough to justify a
configuration change for this lab.

The `250Mi` memory target must not be interpreted the same way. It is the VPA
recommender's default minimum, while actual memory was approximately `117Mi`
at initial idle, `143–184Mi` under load, and `137–138Mi` during recovery. The
experiment therefore does not demonstrate that the application needs a
`250Mi` request. The short-history upper bounds—tens of CPU cores and several
gigabytes of memory—were still converging and are not useful sizing inputs.

The existing CPU request and limit (`500m`/`1000m`) and memory request and
limit (`192Mi`/`256Mi`) remain unchanged.

## HPA and VPA interaction

The HPA targets CPU utilization at 70% of the `500m` request, which corresponds
to approximately `350m` used CPU per Pod. If VPA automatically changed the CPU
request to `511m`, the same 70% HPA target would instead correspond to about
`358m` per Pod.

Automatic VPA request changes would continuously alter the HPA utilization
denominator. The two controllers could then form interacting control loops:
the VPA would change each Pod's request while the HPA used that changing
request to choose the replica count. For this workload, VPA therefore remains
recommendation-only with `updateMode: "Off"`; Phase 6 resource values remain
the control input to the Phase 7 HPA.

## Limitations

- VPA had only a short observation history.
- Only one 15-minute loaded run was performed.
- The HPA changed the replica count during the experiment.
- No immediate post-load snapshot was captured.
- The first recovery snapshot was approximately ten minutes after load stopped.
- The upper bounds were still converging.

These limitations prevent treating the recommendation as a universal
production sizing result. They do not prevent the lab comparison from passing:
the experiment captured a sustained-load recommendation, compared it with the
manually selected resources, and verified that Off mode preserved the running
configuration.

## Verdict

**Phase 8 VPA recommendation comparison: PASS.** Existing resource settings
are retained.
