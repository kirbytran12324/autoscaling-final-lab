# Whole-system refactoring

The four stages are implemented in the working tree. Existing explorer work is preserved. Public APIs, CLI arguments, canonical tournament formats, deterministic rules, and per-result durability are unchanged. The only optional runner addition is diagnostic output through `RUNNER_DIAGNOSTICS=1`.

## Module ownership and dependency direction

| Area | Ownership | Dependency direction |
| --- | --- | --- |
| `simulator/src/tournament/` | Constants, seeded roster ordering, schedules, group records/standings, bracket progression, series resolution | Pure domain calculations; no filesystem, HTTP, runner, or report dependencies |
| `simulator/src/state/` | Artifact contracts, atomic JSON files, append/flush JSONL, immutable roster, initialization/resume | Filesystem primitives and domain validation; no executor or reporting dependencies |
| `simulator/src/runner/` | Separate group/knockout recovery, plan validation, execution, artifact construction, orchestration | Domain and state modules; one shared acceptance queue and failure classifier; explicit stage transitions |
| `simulator/src/artifacts/` | Required/optional reads and completed standings/bracket validation | State and domain contracts; no HTTP or rendering |
| `simulator/src/report/` | Shared statistics, attribution, formatting, report sections, assets, offline composition | Validated artifacts and pure domain helpers; no API dependencies |
| `explorer-api/src/store/` | Safe artifact access, globally serialized run caching, summaries, cursors, match indexes/queries, report access | Validated simulator loader and shared report calculations; no HTTP dependency |
| `explorer-api/src/app.js`, `server.js` | HTTP route/query validation, public errors, server lifecycle | Store interface; storage calculations stay outside handlers |
| `explorer-web/src/report/` | Summary, verification, standings, knockout, battle browsing, pod attribution, details, navigation | Typed API responses and shared UI components; request/cursor lifecycle in `usePaginatedRequest.ts` |
| `scripts/lib/` | Shared configuration checks, fingerprints, cleanup; separate resource/HPA guards, sampling, status schemas | Entrypoint scripts supply validated configuration; Kubernetes sampling policies remain distinct |
| `simulator/test-support/` | Reusable deterministic fixtures | Public simulator entry modules; behavior suites own assertions |

`tournament.js`, `runner-state.js`, `runner.js`, `report-loader.js`, `report-renderer.js`, API `artifact-store.js`, and web `ReportView.tsx` remain compatibility entrypoints. New modules should import the narrowest appropriate dependency. Domain code must not reach upward into execution, storage, or presentation.

## Stage 1: confirmed bugs

Pending artifact loads are shared by run ID and artifact signature, with one global heavyweight-load lane and one retained full run. Failure cleanup permits a subsequent retry. Wrapped filesystem outages return safe HTTP 500 errors; malformed or incomplete tournament evidence remains HTTP 422. Run discovery propagates outages.

Paginated web requests bind their page and cursors to the current request identity. Filter changes disable pagination immediately; cancellation prevents obsolete responses from winning races. Failed updates clear the old page so its cursor cannot be reused. Repeated Next clicks during loading cannot advance again.

Locust records success and hostname counts only after checking canonical response fields, request identity/participants/seed, finite duration, protocol hash, outcome/winner coherence, turns, and termination. The real pinned Locust dependency was used for local tests.

## Stage 2: domain, recovery, persistence, execution

The former runner and rules monoliths are separated into the ownership boundaries above. Recovery tests retain out-of-order completion, stale checkpoints, immutable roster conflicts, duplicate deterministic conflicts, storage failures, round barriers, and interrupted finalization.

Each accepted result still appends and flushes before the checkpoint advances. Both executors use the same serialized acceptance queue and failure classification; group prefix progression and knockout series/round barriers remain stage-specific. Storage failures do not mark tournaments failed. Truncated JSONL is rejected without repair or truncation.

Diagnostics report request duration, acceptance queue wait, result append/flush, checkpoint writes, derived-artifact computation/writes, and heap usage. Programmatic callers can supply `onDiagnostic(event)`; the CLI emits those events to stdout only when `RUNNER_DIAGNOSTICS=1`. Diagnostic failures cannot change tournament acceptance. Diagnostics are never written into canonical tournament evidence.

## Stage 3: reports and explorer reads

Online projections and offline reports share statistics, pod attribution, and duration formatting. Completed artifacts are parsed as JSONL once; temporary text is bounded by the stream chunk plus one record. Strict blank-line, malformed-line, missing-required-file, duplicate-conflict, and final-newline validation remains intact.

Each loaded run retains canonical result records and a match-ID map referencing those records. Match browsing sorts compact result-index arrays, enriches returned rows only, and reuses an `Intl.Collator`. All six supported sorts and both directions preserve the previous ordering, including ascending match IDs when primary keys tie in descending sorts. Eight filtered index lists are retained with LRU eviction. A changed artifact signature replaces the run and its indexes.

On `full-1025-002` (130,975 matches), Node.js 24.20.0 on the same workstation measured:

| Measurement | Audit baseline | Refactored |
| --- | ---: | ---: |
| Cold loading | 2,939 ms | 1,726 ms |
| Initial default page | 3,795–5,211 ms across audit requests | 351 ms |
| Warm default-page p95, 30 consecutive pages | Not sampled as p95 | 1.70 ms |
| Process peak RSS | Approximately 848 MiB | 414 MiB |
| Warm event-loop maximum delay | Not sampled | 9.98 ms |

Cold artifact validation still causes an approximately 1,076 ms event-loop pause. This remains a future optimization candidate; the warm pagination target below 250 ms is met. Workstation figures do not establish live cluster throughput or PVC performance. Complete measurements and deterministic run digests are in `refactoring-validation.json`.

## Stage 4: scripts, tests, provenance, CI

Capture entrypoints source focused helpers; the resource and HPA sampling policies and artifact formats retain their distinct behavior. ShellCheck validates libraries through the entrypoints that supply their configuration; Bash syntax checks include every sourced library. Isolated capture tests exercise fingerprints, refusal of mutating HPA commands, and configuration rejection without contacting Kubernetes.

Large tournament, runner, knockout, lifecycle, and client suites are split by behavior with shared fixtures. All maintained source, tests, and scripts are below 500 lines. `node scripts/check-file-size.js` reports files above the 500-line target and fails above the 800-line ceiling. Generated output, dependencies, vendored code, and historical evidence are outside its maintained-file scopes. Small focused modules and compatibility facades are permitted.

Report provenance hashing recursively covers nested JavaScript modules. Container builds copy those modules, and the simulator test image includes shared fixtures. Production container smoke checks also cover four API routes and report generation with the export script mounts on disposable evidence. System CI runs simulator/API/browser/Locust suites, the web production build, capture policy tests, shell checks, overlay rendering, file-size checks, and all four container builds. Simulator changes trigger explorer checks because the API imports simulator modules.

## Validation and repeatable commands

Local results: 321 simulator, 23 API, 9 browser, 7 Locust, and 3 capture-policy tests passed; browser production build, twelve overlay renders, shell checks, and all four container builds passed. All five committed completed runs load successfully. Comparison against the original revision confirms identical deterministic result records, standings, champions, roster hashes, and public entrypoint exports. Both sample offline reports are byte-for-byte identical at a fixed generation timestamp.

From the repository root, with Node.js 24 and installed simulator dependencies:

```sh
node scripts/check-file-size.js
node scripts/validate-completed-runs.js
node scripts/benchmark-explorer.js
for script in scripts/*.sh scripts/lib/*.sh; do bash -n "$script"; done
shellcheck -x -P SCRIPTDIR scripts/*.sh
python3 -m unittest discover -s scripts/test -p 'test_*.py'
```

The run-validation and benchmark commands accept an optional state root followed by run ID. The state root contains a `runs/` directory; defaults use `evidence/tournaments`. The benchmark defaults to `full-1025-002` and exits unsuccessfully if warm default-page p95 reaches 250 ms.

Live Kubernetes behavior, deployment rollout, PVC latency, and destructive crash-durability experiments were not exercised. No cluster resources or committed tournament evidence were changed. The knowledge graph generation predates these extractions and excludes tests/scripts; current source checks and executable regressions supplied verification where graph coverage was stale or excluded. This work does not prove the absence of every possible defect.
