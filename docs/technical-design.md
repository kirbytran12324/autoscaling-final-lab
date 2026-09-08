# Metronome Tournament Autoscaling Lab — Technical Design

Status: proposed version-one design, 2026-09-03. This is a design and risk-reduction document, not the completed lab.

## Decision summary

The project is feasible in four days if the Kubernetes autoscaling evidence remains the primary deliverable and the full 1,025-species tournament is treated as a final workload run, not as a prerequisite for proving the application.

Use one stateless HTTP simulator Deployment and one singleton tournament-runner Kubernetes Job. The runner calls the simulator's ClusterIP Service directly and keeps one append-only JSONL result file plus a small checkpoint file on a PVC. Run Locust from WSL through the existing Traefik ingress so load-generator CPU does not contaminate cluster measurements. Do not add a database, message queue, interactive application frontend, or separate Pokémon Showdown server. Generate one small read-only HTML results report from the evidence files.

Pin `pokemon-showdown` to exact version `0.11.11` and commit `package-lock.json`. Add contract tests because the upstream source explicitly warns that the stream format is not finalized.

## What was verified

The official package exports `BattleStream`, `Dex`, `PRNG`, and `Teams`. The documented simulator interface accepts `>start`, `>player`, and player-choice commands and emits an `end` JSON record. The current `end` record contains the winner, original seed, turns, teams, score, and replayable input log. See the upstream [simulator documentation](https://github.com/smogon/pokemon-showdown/blob/master/sim/SIMULATOR.md), [exports](https://github.com/smogon/pokemon-showdown/blob/master/sim/index.ts), and [Battle end record](https://github.com/smogon/pokemon-showdown/blob/master/sim/battle.ts).

The service should consume the raw `BattleStream`. Do not use `getPlayerStreams` as the result collector: its implementation intentionally ignores the `end` message. It is useful as an example of routing requests, but not as the complete service adapter. See [battle-stream.ts](https://github.com/smogon/pokemon-showdown/blob/master/sim/battle-stream.ts).

The pinned package was installed in a disposable spike and exercised with Snorlax versus Clefable. Two runs using the same teams and seed produced identical simulator protocol after excluding the wall-clock timestamp. The package data returned:

- 1,025 unique base species, Bulbasaur through Pecharunt;
- 581 moves callable by Gen 9 Metronome; and
- a primary (`0`) ability for every selected base species.

This move count must be a contract-test expectation for version `0.11.11`, not a hand-maintained move list. The Gen 9 implementation selects moves where `isNonstandard` is absent or `Unobtainable`, and the move has the `metronome` flag. See [Metronome's implementation](https://github.com/smogon/pokemon-showdown/blob/master/data/moves.ts).

The label `group1-match9021` is not a valid Showdown seed and is rejected. Keep a human-readable seed label, but derive and record the four-number Showdown seed separately.

The disposable spike is in [`tmp/metronome-api-spike`](../../tmp/metronome-api-spike/). Its generated dependencies were removed; `npm ci` recreates them.

## Smallest working one-battle prototype

The first real prototype needs only one module and one test. It should:

1. Create `new BattleStream()`.
2. Write `>start` with `formatid: "gen9customgame"` and an explicit four-number seed.
3. Write one explicit one-Pokémon team for each player.
4. Read raw stream messages. On a team-preview request, choose team slot 1; on an active request, choose move slot 1.
5. Capture and parse the raw `end` JSON message.
6. Run the same input twice and assert the normalized protocol, winner, turns, and returned seed are equal.

This proves the risky integration before HTTP, containers, or Kubernetes are introduced. A human-readable response wrapper comes afterward.

Do not use a wall-clock timeout as a draw rule. CPU contention during load testing would then change tournament results. A wall timeout is an operational failure that the runner retries with the same inputs; only the deterministic turn cap produces a draw.

## Version-one tournament rules

### Roster and grouping

- Use `Dex.mod('gen9').species.all()` from the pinned package.
- Include only entries with National Dex number 1 through 1025 and `name === baseSpecies`. Assert both roster length and unique number count are 1,025.
- Sort by National Dex number before shuffling.
- Derive a roster seed from `SHA-256(UTF8(tournamentSeed + "\nroster"))`. Interpret the first eight digest bytes as four unsigned 16-bit big-endian integers.
- Shuffle with the pinned Showdown `PRNG.shuffle` and save the complete ordered roster as evidence.
- Slice the result, in order, into group sizes 257, 256, 256, and 256.

### Battle set

- Format: `gen9customgame`. This permits the synthetic set without pretending every species can legally learn Metronome.
- One Pokémon per side, level 100.
- IVs: 31 in all six stats.
- EVs: 0 in all six stats.
- Nature: Serious, which is neutral.
- Item: none.
- Move list: Metronome only.
- Ability: the species' primary ability, `species.abilities[0]`.
- Gender: use a species' fixed M/F/N gender; use M for a species with a variable gender ratio.
- Happiness: 255.
- Never choose Terastallization. A Metronome-called Tera Blast therefore behaves as the engine defines it for a non-Terastallized Pokémon.
- The simulator, not our code, chooses the called move and resolves battle mechanics.

### Seeds and side assignment

Every simulation has a unique stable `match_id`, for example `group-A-000001` or `r64-series-03-game-2-attempt-1`.

Derive its Showdown seed as follows:

```text
digest = SHA-256(UTF8(tournamentSeed + "\n" + match_id))
showdown_seed = [u16be(digest[0:2]), u16be(digest[2:4]),
                 u16be(digest[4:6]), u16be(digest[6:8])]
```

Record `tournament_seed`, `match_id`, and `showdown_seed`. Reproducibility also requires the exact package version, rules, teams, and choices; a seed alone is insufficient.

For each group match, use the next digest bit to decide which participant is p1. In knockout series, alternate p1 between games. This makes any side-order effect deterministic and balanced rather than silently assigning it by Pokédex order.

### Completion, draws, and errors

- Maximum: 100 completed turns. If the simulator begins turn 101, send `>forcetie` before accepting more choices.
- A natural Showdown tie is also a draw.
- An application timeout, stream exception, invalid response, or HTTP failure is not a draw. Retry the same `match_id` and seed up to three times with exponential backoff, then stop the tournament as failed.
- Keep the full input log for failed or sampled battles, but do not store every full battle protocol by default. The protocol includes a wall-clock timestamp and can make evidence unnecessarily large.

### Group stage

For a group of `n`, generate every unordered pair `i < j` exactly once. The match counts are:

- group A: `257 × 256 / 2 = 32,896`;
- each other group: `256 × 255 / 2 = 32,640`; and
- total group stage: **130,816 battles**.

Scoring is win = 3 points, draw = 1 point each, loss = 0. Rank by:

1. total points;
2. mini-table points from matches among the tied cohort;
3. total wins;
4. Sonneborn–Berger score, represented as an integer: twice each defeated opponent's final points plus each drawn opponent's final points; and
5. ascending deterministic tie key `SHA-256(tournamentSeed + "\nrank\n" + group + "\n" + speciesId)`.

The final key is an explicit reproducible lottery, not a claim of sporting merit. Save every intermediate tie-break value in the standings output. Advance ranks 1–16 from each group.

### Knockout stage

- Round of 64 pairs A with B and C with D. Rank `r` faces rank `17-r` from the paired group. Lay out the fixed bracket so adjacent series alternate which group supplies the higher seed. No same-group rematches can occur in round one.
- Do not reseed after a round; winners advance through the recorded bracket.
- A series is first to two decisive battle wins. Drawn simulations do not count as a win and use the next attempt seed.
- Cap a series at seven total simulations. If neither participant has two wins, advance the one with more decisive wins; if still tied, use an explicitly recorded deterministic hash lottery.

There are 63 knockout series and 126–441 simulations under these rules. The overall tournament therefore contains 130,942–131,257 simulations.

## Application and API boundary

The service owns the fixed rules. Clients select two valid base species and supply identity/seed data; they cannot submit arbitrary teams, moves, abilities, or formats.

Suggested version-one endpoints:

- `POST /v1/battles`: validate, simulate one battle, return its result.
- `GET /healthz`: process is alive.
- `GET /readyz`: pinned Dex is loaded and roster/move-count contract checks have passed.

Minimum response fields are `match_id`, both species, nullable winner, `result` (`win` or `draw`), turns, seed label, four-number Showdown seed, simulator version, and Pod name from `HOSTNAME`. Remaining HP percentage is intentionally deferred: it is not present in the end record and would require careful parsing of split private/public protocol messages. It is not needed for version-one standings or autoscaling evidence.

## Results interpretation interface

A minimal interface is justified because 130,000-plus JSONL records are reproducible but difficult to interpret or present. It should be a generated evidence artifact, not a second stateful application.

The runner writes canonical machine-readable files to the PVC:

- `run-metadata.json`: seed, rule version, dependency/image versions, timestamps, and completion state;
- `results.jsonl`: one immutable record per simulation;
- `standings.json`: group scores and every tie-break value;
- `bracket.json`: fixed bracket positions, series games, and winners; and
- `autoscaling-timeline.csv`: timestamped replicas, CPU, request rate, failures, and latency gathered during the dedicated load test.

A `report` command reads those files and produces a self-contained `report.html` with embedded data, CSS, and JavaScript. It must work offline after being copied into the repository; do not depend on a CDN. Regenerating it from the same inputs should produce the same substantive content, excluding an explicitly labelled generation timestamp.

The first interface needs only:

1. a run-summary header with seed, versions, progress, match counts, draws, retries, and failures;
2. four sortable group tables with a visible top-16 cutoff and tie-break columns;
3. the 64-entry knockout bracket and per-series game results;
4. a searchable battle table showing match ID, participants, winner/draw, turns, seed, and serving Pod; and
5. an autoscaling chart aligning replicas and CPU utilization with request rate, p95 latency, and failures.

The report is read-only: it must not start battles, alter standings, or become the source of truth. Its purpose is interpretation, screenshots, and browser print-to-PDF for the audit. During early phases, generate it from the 16- or 32-species sample; the same generator later handles the full run.

## Work distribution without a database or queue

```text
Tournament runner Job ---------------------> ClusterIP Service
        |                                          |
        v                                          v
results/checkpoint PVC                  stateless simulator Pods
                                                   ^
WSL Locust -> Traefik Ingress -> ClusterIP Service |
Metrics Server -> HPA ------------------------------|
VPA recommender -> VPA status (read-only recommendation)
```

The singleton runner Job generates a deterministic schedule and uses a bounded HTTP worker pool. After each success, it appends one result line to `results.jsonl` on a small ReadWriteOnce PVC. A checkpoint contains the tournament seed, rules version, dependency version, completed match IDs, and current bracket state. If the Job's Pod restarts, it reloads results, ignores completed IDs, and safely resends missing work. Duplicate responses are harmless because a `match_id` has deterministic inputs and only one result is accepted. Copy the completed artifacts from the PVC into the repository's evidence directory.

The runner resolves the Service by Kubernetes DNS and never needs external exposure. Use the existing Traefik ingress only for WSL-based Locust and manual smoke tests. A Kubernetes Service routes connections, not a guaranteed round-robin sequence of HTTP requests; keep-alive can make distribution uneven. Use enough independent client connections and confirm distribution from the returned Pod names. Do not claim that every request is round-robin.

Do not autoscale the runner. It is one coordinator with one authoritative checkpoint; multiple runner replicas would require leader election or partition ownership and would recreate the queue/database problem we are deliberately avoiding. Give the Job measured requests and limits, but let the HPA target only the stateless simulator Deployment. Locust also stays outside the cluster so its own CPU and memory do not consume the capacity being measured.

Group matches are fully independent and can use the worker pool. Knockout bracket rounds are barriers: series within a round run concurrently, then the runner waits for every winner before creating the next round.

## Why this is a meaningful HPA workload

Battle simulation is CPU-bound, stateless, independently repeatable work. A Node.js process executes JavaScript on one main event loop, so one saturated Pod cannot turn HTTP concurrency into unlimited CPU parallelism. Additional Pods allow the cluster to use additional cores. This is a legitimate horizontal-scaling case.

CPU `averageUtilization` is a percentage of each container's CPU **request**, not its limit. Kubernetes uses approximately:

```text
desiredReplicas = ceil(currentReplicas × currentUtilization / targetUtilization)
```

For example, with four replicas averaging 90% against a 60% target, the raw recommendation is `ceil(4 × 90 / 60) = 6`. Missing CPU requests make utilization undefined. See the official [HPA algorithm](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/) and [resource request/limit behavior](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/).

Do not choose final requests and limits in this design. First run one Pod at a declared sustainable load for at least ten minutes and sample CPU and memory every 15 seconds. A defensible initial method is:

- CPU request: observed p95 CPU at the chosen sustainable per-Pod load divided by the 0.60 HPA target, rounded to a documented practical unit.
- CPU limit: above observed peak with documented burst headroom, but no more than the useful single-process ceiling.
- Memory request: observed p95 working set plus measured headroom.
- Memory limit: above observed maximum plus a larger safety margin, then verify no OOM kills.

Use `autoscaling/v2`, a provisional `minReplicas: 1`, `maxReplicas: 12`, CPU target 60%, and an explicit 300-second scale-down stabilization window. Revisit the maximum after reading node allocatable capacity. The five-minute window makes scale-in slower by design and prevents thrashing; evidence collection must continue long enough to capture it. Kubernetes documents the default five-minute downscale stabilization behavior in the [HPA behavior section](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/).

Locust should have four named profiles: idle, sustainable steady load, spike load held for several metrics collection intervals, and recovery. Record timestamps, current/desired/ready replicas, per-Pod CPU/memory, request rate, failures, and p50/p95 latency at a fixed interval. A very short spike is invalid evidence because Metrics Server and the HPA reconcile periodically.

## What proves that scaling helped

Do not create one Kubernetes Job per battle and do not start several tournaments merely to manufacture load. One full tournament already contains more than 130,000 independent HTTP battle requests. The singleton runner keeps a configurable number of those requests in flight; the ClusterIP Service sends connections to Ready simulator endpoints, and the HPA changes the number of those endpoints by scaling the simulator Deployment.

Keep functional correctness and autoscaling proof as two related but separate experiments:

1. **Single-Pod baseline:** disable HPA or hold the Deployment at one replica. Replay a fixed deterministic battle corpus at a concurrency that drives the Pod above the intended 60% CPU target. Capture throughput, p95 latency, failures, CPU, memory, and throttling for at least five minutes.
2. **HPA comparison:** use the same image, resources, battle corpus, client concurrency, and duration, but enable HPA. Capture when desired/current/ready replicas change and compare throughput and latency with the baseline. The useful result is not merely “more Pods existed”; it is that work was spread across them and service behavior improved or remained acceptable.
3. **Recovery:** stop the load and continue collecting for longer than the 300-second scale-down stabilization window. Show CPU falling first and replica count returning to the minimum later.
4. **Real-workload run:** run the full tournament once with HPA enabled. It should reproduce the same scale-out and recovery pattern, but it is supporting evidence rather than the only controlled test.

Choose runner/Locust concurrency from measurement: increase it until one Pod is CPU-saturated and latency begins to queue, then keep that value constant for the one-Pod and HPA comparisons. Concurrency must be high enough to keep additional replicas busy; otherwise new Pods cannot improve throughput.

Each battle response includes the serving Pod name. Aggregate completed battles by Pod and by time bucket. Correlate that with:

- the Service's EndpointSlices, showing only Ready simulator endpoints;
- Deployment/HPA events, showing when new Pods were created;
- `kubectl get pods -o wide`, showing which nodes received the Pods; and
- per-Pod CPU from Metrics Server.

New Pod names appearing in results after scale-out prove that requests reached the new replicas. A soft topology spread constraint (`whenUnsatisfiable: ScheduleAnyway`) can encourage simulator Pods across both schedulable workers without making normal scheduling brittle. The third Ready node is the tainted control plane and remains unavailable to ordinary application Pods. Kubernetes schedules Pods onto nodes; it does not assign individual battle Jobs to simulator Pods. Service networking routes the runner's HTTP connections to the Ready simulator Pods.

For Kubernetes 1.36, pin the currently compatible Metrics Server application `0.9.0` / Helm chart `3.14.0`; the upstream compatibility table says 0.9.x supports Kubernetes 1.34+. First test normal TLS settings. Add `--kubelet-insecure-tls` only if Docker Desktop's kubelet certificate actually fails validation, and capture that error and rationale. See the [Metrics Server compatibility and installation notes](https://github.com/kubernetes-sigs/metrics-server#readme).

Pin VPA `1.7.1` / chart `0.11.0` and set `updateMode: "Off"`. Compare `lowerBound`, `target`, and `upperBound` after it has collected representative idle and loaded samples. Off mode still writes recommendations but never changes Pods. Upstream explicitly warns against VPA and HPA controlling the same CPU metric: changing CPU requests changes the HPA utilization denominator, so two feedback loops can fight. See the [VPA API](https://github.com/kubernetes/autoscaler/blob/master/vertical-pod-autoscaler/docs/api.md) and [known limitations](https://github.com/kubernetes/autoscaler/blob/master/vertical-pod-autoscaler/docs/known-limitations.md).

The lab uses the first of these conflict-avoidance strategies and explains the alternatives:

- **Recommendation only (chosen):** keep VPA in `Off` mode while the CPU-utilization HPA is active, then review its recommendation without allowing it to mutate requests.
- **Separate metrics:** let VPA manage CPU requests only when HPA scales on a metric whose denominator VPA does not change, such as an external queue-depth metric.
- **Separate phases or workloads:** disable the HPA while applying a VPA recommendation, or run VPA mutation on a different workload from the HPA-controlled simulator.

Before each acceptance run, validate every lab-owned regular and init container in the `autoscaling-lab` namespace. Each must declare both CPU and memory requests and limits. Save the machine-readable Pod-spec check with the evidence; simulator sidecars, runner containers, and any later helper containers are included rather than checking only the main simulator container.

## Capacity-limited demonstration

Do not use a `ResourceQuota` if the required evidence is Pending Pods. A quota commonly prevents the ReplicaSet from creating Pods and produces `FailedCreate`, which demonstrates admission failure rather than scheduler capacity failure.

Create an isolated `capacity-demo` overlay of the simulator Deployment and target only the schedulable worker nodes. Let `L` be the largest worker's allocatable CPU and choose a demo request `q > L / 2`; this is what guarantees that no eligible node can fit two demo Pods. Also verify `q` is no greater than the smallest worker's currently free requested capacity so that one demo Pod can fit on every worker. Then request `schedulableWorkerCount + 1` replicas. If those two bounds do not overlap on a heterogeneous or busy cluster, use a homogeneous worker subset with node affinity and calculate against that subset. Record allocatable CPU, pre-existing requests, the calculation, and the selected value rather than assuming a node size. Diagnose the remaining Pod with conditions and scheduler events showing `FailedScheduling` / `Insufficient cpu`, then remove the overlay after capturing evidence.

Requests guide scheduling and an unsatisfied request leaves a Pod Pending; limits are runtime enforcement. See [Kubernetes resource management](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/). In a cloud cluster, Cluster Autoscaler could add a VM to a preconfigured node group for the Pending Pod. Docker Desktop has fixed local nodes and no cloud-provider VM/node-group API for the autoscaler to call. See [Kubernetes node autoscaling](https://kubernetes.io/docs/concepts/cluster-administration/node-autoscaling/).

## Cost/performance calculation

The local Docker Desktop run has no defensible per-node cloud charge, so report measured performance locally and a clearly labelled cloud projection separately. For each controlled run record completed battles, elapsed hours, average node count, and any fixed service charges. On the day of the estimate, cite the selected provider, region, instance type, billing unit, and dated official price. Calculate:

`estimated_cost = (average_node_count * instance_hourly_price * elapsed_hours) + prorated_fixed_service_costs`

`cost_per_1,000_battles = estimated_cost / completed_battles * 1,000`

Compare that value alongside throughput, p95 latency, and failure rate. Do not claim that additional Pods cost more unless they actually require additional billed nodes; Kubernetes replicas consume capacity, while cloud billing normally follows the backing infrastructure and managed-service pricing.

## Four-day feasibility risks

| Risk | Effect | Mitigation / decision gate |
|---|---|---|
| Stream API changes | Subtle result or request-routing breakage | Exact dependency pin, lockfile, one-battle and deterministic replay contract tests |
| 130,816 group battles | Full run and evidence volume distract from Kubernetes | Support a small roster mode first; keep JSONL canonical and generate a summarized HTML report; full run is not an HPA acceptance gate |
| Battles are short | Load generator may not sustain CPU saturation | Benchmark first, then raise Locust users/connections; do not add artificial sleeps |
| Keep-alive skews Service routing | One Pod is hot while others appear idle | Multiple client connections; return Pod name and check the distribution |
| A wall timeout changes results under load | Same seed can appear non-reproducible | Treat timeout as retryable operational failure; draws use turn count only |
| Startup CPU and Dex loading distort samples | Misleading sizing/HPA decisions | Readiness only after data checks; exclude warm-up interval from measurements |
| VPA has insufficient history | Weak recommendation comparison | Install before the sustained-load run and record sample duration |
| Docker Desktop metrics TLS fails | No `kubectl top`, HPA shows unknown | Diagnose first; apply insecure kubelet TLS only with captured evidence |
| Package brings server-side dependencies and audit findings | Larger image/security-review noise | Expose only our small service, omit optional/dev dependencies, run and document a scan, do not run the Showdown server |
| Cluster facts differ from the brief | Manifests and capacity demo are wrong | Capture versions, node count, allocatable CPU/memory, Metrics API, default StorageClass, and Traefik release before implementation |

A local 1,000-battle pure-simulator sample across the base roster completed at about 137 battles/second on the current Windows Node.js process, with about 5 turns per battle. That suggests roughly 16 minutes of ideal single-process compute for the group stage, but it is not a service or Kubernetes capacity claim; HTTP, logging, CPU limits, WSL, and matchup distribution will change it.

## Phased implementation plan

Every phase has a runnable exit condition. Stop and fix a failed gate before adding the next layer.

1. **Environment inventory.** Capture Kubernetes/Helm/Docker versions, Ready and schedulable node counts, allocatable and already-requested resources, node taints, Traefik release/values, Metrics API status, and storage/network facts. Exit: a dated environment evidence file explains the actual cluster.
2. **Pinned simulator contract.** Build the one-battle module and tests, including invalid species, deterministic replay, 1,025-species roster, 581-move invariant, natural tie/win parsing, and the turn cap. Exit: local test command passes twice from a clean `npm ci`.
3. **Local HTTP service.** Add `POST /v1/battles`, health/readiness, validation, operational timeout/retryable error distinction, and Pod/version metadata. Exit: local smoke test plus a bounded parallel test returns deterministic results without state leakage.
4. **Container and single-Pod Kubernetes path.** Build a non-root image, deploy one replica with provisional resources, ClusterIP Service, probes, and Traefik route. Exit: WSL reaches the endpoint and the response identifies the serving Pod.
5. **In-cluster runner and report, small tournament first.** Create a singleton Job and small PVC; implement deterministic schedule, JSONL resume, standings, tie-break fields, fixed bracket, and the self-contained HTML report. Run 16 or 32 species end to end through Service DNS. Exit: deleting the runner Pod causes the Job to restart and resume from the PVC without changing prior results, and the copied report opens offline with correct totals.
6. **Measure and right-size.** With HPA disabled and one Pod, collect idle, steady, and saturation data; choose and document requests/limits from the observations. Exit: rerun at the chosen sustainable load with acceptable latency, no OOM, and no unexplained throttling.
7. **Metrics Server, HPA, and Locust evidence.** Install pinned Metrics Server if absent, apply HPA, run idle/steady/spike/recovery, and capture a synchronized scaling timeline. Exit: evidence shows scale-out and later scale-in, with the HPA calculation explained from one observed sample.
8. **VPA recommendation comparison.** Install pinned VPA in Off mode before a representative sustained run. Exit: saved VPA status is compared numerically with manual requests and the HPA/VPA CPU conflict is explained.
9. **Capacity and scheduler diagnosis.** Apply the isolated capacity overlay, capture Pending Pod events, calculate why no node fits, explain cloud node autoscaling, then remove the overlay. Exit: evidence shows scheduler failure, not quota admission failure.
10. **Final run and audit package.** Run all 1,025 species as the required functional capstone, then assemble the README, cost/performance note, manifests, exact install commands, versions, measurements, logs, and cleanup steps. The full tournament is required for project completion but is not the HPA acceptance gate; the fixed-corpus comparison remains the controlled autoscaling proof. Exit: every assignment and checklist item links to a specific artifact.

Suggested four-day split: day 1 phases 1–3; day 2 phases 4–6; day 3 phases 7–8; day 4 phases 9–10 and rehearsal.

## Confirmed deployment boundary

Kubernetes runs the simulator Deployment, its HPA, and one tournament-runner Job with a small results PVC. Only the stateless simulator Pods autoscale. Locust runs from WSL as an independent external observer and load source.
