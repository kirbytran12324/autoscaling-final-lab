# Phase 10 runner memory incident

## Status

Diagnosis, disposable validation, and authoritative recovery were completed on
2026-09-15. The interruption and resume are an operational history of the run;
trust in the tournament outcome comes from validation of the final canonical
artifacts, not from treating a particular Job or Pod lifecycle as authoritative.

## Run configuration

The first full 1,025-species tournament used:

- Job: `tournament-runner-full`;
- run ID: `full-1025-001`;
- mode: `full`;
- seed: `full-1025-seed-001`;
- concurrency: `6`;
- rules version: `metronome-singles-v1`;
- simulator version: `pokemon-showdown@0.11.11`;
- image: `metronome-simulator:phase10`;
- PVC: `tournament-state`;
- runner memory request: `128Mi`;
- runner memory limit: `512Mi`.

VPA remained in recommendation-only (`Off`) mode. Only the simulator Deployment was managed by the HPA.

## Timeline and confirmed observations

The run started at `2026-09-15T03:24:02.653Z`.

An intermediate checkpoint captured during group-stage execution contained:

```json
{
  "stage": "groups",
  "round": null,
  "acceptedResultCount": 45751,
  "schedulePosition": 45750,
  "updatedAt": "2026-09-15T03:33:06.953Z"
}
```

This was an intermediate progress observation, not the failure point. The one-result difference was compatible with concurrency: `acceptedResultCount` includes all accepted results, while `schedulePosition` represents the completed contiguous schedule prefix.

During execution, the HPA created six Ready simulator Pods. Multiple simulator Pods showed non-zero CPU usage, demonstrating that runner requests reached more than one Service endpoint.

The final persisted checkpoint recovered after failure contained:

```json
{
  "stage": "knockout",
  "round": "r4",
  "acceptedResultCount": 130962,
  "schedulePosition": 0,
  "updatedAt": "2026-09-15T03:49:11.326Z"
}
```

The group stage required 130,816 results. Therefore, the runner completed the group stage and accepted another 146 knockout results.

A checkpoint at `r4` with schedule position `0` means the preceding `r8` round completed and the `r4` semifinal round was constructed, but no `r4` result had yet been accepted. The remaining rounds were `r4` and `r2`.

The Job eventually exhausted its retry allowance and reported `Failed` with `0/1` completions. Four sequential Job Pods terminated with exit code `134` and reason `Error`:

- `tournament-runner-full-97czr`;
- `tournament-runner-full-k7d9t`;
- `tournament-runner-full-wgq5x`;
- `tournament-runner-full-wx745`.

The logs reported an out-of-memory failure. Kubernetes did not classify the containers as `OOMKilled`.

## Persisted-state reconciliation

A temporary Kubernetes Pod mounted the `tournament-state` PVC read-only. The interrupted run was copied to:

```text
/home/kirbymoto/phase10-profile/original-512Mi-run/full-1025-001
```

The PVC contained:

| Artifact | Size |
| --- | ---: |
| `results.jsonl` | 52,005,542 bytes |
| `run-metadata.json` | 326 bytes |
| `bracket.json` | 93,384 bytes |
| `roster.json` | 86,486 bytes |
| `checkpoint.json` | 141 bytes |
| `standings.json` | 254,353 bytes |

Reconciliation confirmed:

- `results.jsonl` contains 130,962 lines;
- every result record is valid JSON;
- no duplicate match IDs were found;
- the checkpoint accepted-result count is also 130,962;
- metadata retains the original immutable tournament identity;
- metadata status remains `running`;
- SHA-256 checksums match between every copied artifact and its PVC source.

The verified local copy is therefore byte-for-byte identical to the authoritative interrupted state captured from the PVC.

## Termination classification

The Pods terminated with exit code `134` and Kubernetes reason `Error`. A Kubernetes cgroup-level OOM kill would normally be reported as `OOMKilled` and commonly exits with code `137`.

Exit code `134`, together with the out-of-memory log message and the measured
V8 heap ceilings below, is strongly consistent with the Node.js process
aborting after V8 JavaScript heap exhaustion. No peak heap, RSS, or container
memory measurement was captured at the failure instant.

A post-failure node snapshot showed:

| Node | Current memory | Current utilization |
| --- | ---: | ---: |
| `desktop-control-plane` | `915Mi` | 11% |
| `desktop-worker` | `352Mi` | 4% |
| `desktop-worker2` | `537Mi` | 6% |
| `desktop-worker3` | `363Mi` | 4% |

This snapshot was taken after failure and does not establish node utilization at the failure instant. It does show that the cluster was not generally memory-exhausted when the diagnosis was recorded.

## Runtime heap evidence

The Phase 10 image uses Node.js `v24.20.0`.

The effective V8 heap ceiling was measured using disposable containers created from the same image:

| Container memory limit | V8 heap limit |
| ---: | ---: |
| `512Mi` | `259Mi` |
| `2Gi` | `1,120Mi` |

The JavaScript heap is intentionally smaller than the container limit because the process also requires native allocations, buffers, stacks, runtime memory, and other non-heap data.

Increasing the container limit from `512Mi` to `2Gi` automatically increased the V8 heap limit. An explicit Node heap override has not been demonstrated as necessary.

An offline reconstruction under the original `512Mi` limit successfully loaded all 130,962 established results and reached the first missing `r4` battle without an out-of-memory failure. Reconstruction alone is therefore not sufficient to explain the Kubernetes failures.

A disposable recovery under a `2Gi` limit used the same image, immutable tournament identity, configuration, checkpoint, and concurrency as the interrupted run. It completed successfully with exit code `0`, `oomKilled=false`, and exactly 130,969 unique, valid results. The completed disposable copy recorded Giratina as champion.

This validates resource-only recovery as a workable approach for this run. It does not prove that `2Gi` is the minimum sufficient limit or identify the precise peak allocation.

## Working diagnosis

The immediate failure is strongly consistent with runner-process heap
exhaustion, not simulator HPA failure or demonstrated exhaustion of aggregate
cluster memory. It was not accompanied by a peak-memory measurement.

The runner reconstructs validated results from `results.jsonl` and retains complete result records in an in-memory `acceptedRecordsByMatchId` map. It also retains the tournament schedule, completed-match IDs, missing matches, standings inputs, bracket state, and validation structures.

These structures scale with tournament size and require more heap than the 52 MB serialized result file alone.

The runner successfully completed the full group stage and several knockout rounds. Therefore, the evidence does not support describing the failure as occurring at 45,751 results or as simple linear exhaustion during the early group stage.

The offline `512Mi` reconstruction rules out reconstruction by itself as a sufficient explanation. The leading hypothesis is now a runtime peak associated with resuming or executing the remaining knockout battles under the original 259Mi heap ceiling. The disposable `2Gi` completion shows that additional memory avoids the failure without changing the image, identity, configuration, checkpoint, or concurrency.

The exact allocation responsible for the peak remains unconfirmed. The successful `2Gi` run neither locates that allocation nor establishes the minimum sufficient memory limit.

## Authoritative recovery and final state

The new singleton Job `tournament-runner-full-resume-1` mounted the
authoritative `tournament-state` PVC and resumed the existing run. The original
manifest defined a `128Mi` memory request and `512Mi` limit; the recovery
manifest defined a `1Gi` request and `2Gi` limit. Run ID, mode, seed, runner
concurrency, rules version, simulator version, simulator image, and PVC were
unchanged.

The observed recovery execution used one Pod, completed with exit code `0`,
and took 36 seconds. Those are Kubernetes observations whose raw captures were
not retained in this repository; the durable acceptance boundary is the final
artifact reconciliation below.

Artifact reconciliation verified this transition:

| Boundary | Accepted results | Checkpoint |
| --- | ---: | --- |
| Interrupted state | 130,962 | `knockout` / `r4` / position `0` |
| Completed state | 130,969 | `complete` / `r2` / position `3` |

Exactly seven newline-terminated results were appended to `results.jsonl`.
They cover the two semifinal series and final series. All seven records report
the hostname `metronome-simulator-558bdb896d-4qmrc` in `servedBy`. That field
attributes accepted responses to a reported hostname; it does not establish a
Pod UID, readiness interval, restart history, simultaneous replica count, node
placement, or other lifecycle fact.

The completed local artifact copy and the PVC copy had matching SHA-256 values
for `run-metadata.json`, `roster.json`, `results.jsonl`, `checkpoint.json`,
`standings.json`, and `bracket.json`. The final artifacts contain 130,969
unique accepted match IDs, a final group standing with 130,816 results, a
completed six-round knockout bracket, and Giratina as champion.

The successful recovery demonstrates that the increased memory allocation was
sufficient for this short resume. It does not prove that `2Gi` is the minimum
sufficient limit or identify the dominant allocation. Bounded-memory runner
refactoring remains future work.

## Evidence boundary

The accepted-result transition, final checkpoint, immutable identity, final
standings and bracket, champion, reported hostnames, and local/PVC checksum
agreement are artifact-verified facts. The manifest-defined resource change is
verified by the committed original and recovery Job manifests.

The failed Job status, four exit-code-134 terminations, log wording, recovery
Pod exit code and runtime, and contemporaneous cluster observations were
recorded during diagnosis, but their raw Kubernetes captures were not retained
in this repository. They remain operational observations rather than inputs to
the tournament result validation. Phase 7 autoscaling captures are separate
experiment evidence and are not tournament-run telemetry.

Further profiling may measure RSS, heap used, heap allocated, external memory,
and heap ceiling to identify the precise peak and evaluate a lower safe limit.
Bounded-memory reconstruction and runtime behavior remain candidates for
long-term remediation.

Any implementation redesign must preserve duplicate-result protection, deterministic standings, append-only authoritative results, atomic checkpoints, and immutable restart validation.
