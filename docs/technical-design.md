# Metronome Tournament Autoscaling Lab — Technical Design

Status: active implementation design, updated 2026-09-08.
Final resource sizing, HPA values, VPA comparison and acceptance results remain pending.

## Environment

The lab runs on a Docker Desktop kind cluster with Kubernetes `v1.36.1`. The cluster has four nodes: three schedulable workers and one control-plane node protected by a `NoSchedule` taint. The default local-path StorageClass uses `WaitForFirstConsumer` volume binding.

Metrics Server is installed and working. Test traffic stays inside the cluster, so the accepted test path has no current Traefik dependency.

## Decision summary

The system consists of:

- one stateless simulator Deployment;
- one singleton tournament-runner Job;
- one fixed-replica Locust Deployment in the `load-testing` namespace;
- one ClusterIP Service used by both the runner and Locust;
- one PVC for runner results and checkpoints; and
- a report command that generates a self-contained offline HTML report.

Only the simulator Deployment is an HPA target. The runner is a single coordinator, and Locust keeps a fixed replica count. The core lab system does not require a database, message queue, or external Pokémon Showdown server.

A read-only Pokémon Showdown replay viewer is an optional personal-interest extension after the 32-species sample tournament is complete. It does not change the lab acceptance criteria or autoscaling boundary, and it must not delay the runner, restart/resume, report, resource-sizing, HPA, VPA, or capacity evidence.

The simulator pins `pokemon-showdown` to exact version `0.11.11` and commits `package-lock.json`. Contract tests protect the application from unexpected assumptions about the pinned simulator interface and data.

## Verified implementation

The following implementation is complete and verified:

- `pokemon-showdown@0.11.11` is pinned with a committed lockfile;
- the battle module uses explicit teams and four-number seeds to produce deterministic results;
- catalog tests enforce the 1,025-base-species roster and 581 Metronome-callable-move contracts;
- battles apply a deterministic completed-turn cap rather than treating a wall-clock timeout as a draw;
- the HTTP service validates requests and returns deterministic battle results;
- automated catalog, battle, turn-cap, validation, and HTTP endpoint tests pass;
- the simulator container runs as a non-root user;
- Kubernetes manifests define the simulator Deployment and ClusterIP Service;
- Metrics Server is installed and supplies node and Pod resource metrics;
- Locust runs as an in-cluster workload; and
- one-replica and three-replica exploratory experiments have been completed.

The implemented request and response shapes are documented in the [Simulator API Contract](api-contract.md). The exploratory results and evidence links are recorded in the [single-Pod baseline](baseline-experiment.md) and [three-Pod experiment](three-pod-experiment.md).

### Pokémon Showdown integration rationale

The simulator uses the raw `BattleStream` interface because it exposes the complete simulator protocol, including the final `end` record needed to collect the winner, turn count, seed, and replay metadata. The application sends `>start`, `>player`, and deterministic player-choice commands, then parses that terminal record. The upstream [simulator documentation](https://github.com/smogon/pokemon-showdown/blob/master/sim/SIMULATOR.md), [simulator exports](https://github.com/smogon/pokemon-showdown/blob/master/sim/index.ts), and [battle end implementation](https://github.com/smogon/pokemon-showdown/blob/master/sim/battle.ts) document this interface and result path.

`getPlayerStreams()` is not used as the result collector because its routing implementation intentionally omits the `end` message from the player streams. It is useful as a request-routing reference, but would hide the authoritative terminal record required by this workflow; see the upstream [battle stream implementation](https://github.com/smogon/pokemon-showdown/blob/master/sim/battle-stream.ts).

The application supplies fixed teams and selects Metronome, but does not choose the move called by Metronome or reimplement battle rules. Pokémon Showdown selects the called move and resolves the mechanics using the pinned engine and data. The upstream [Metronome implementation](https://github.com/smogon/pokemon-showdown/blob/master/data/moves.ts) is also the basis for the 581-callable-move contract test.

## Architecture and workload ownership

```text
Tournament runner Job ──────┐
                            ├──> ClusterIP Service ──> simulator Pods
Locust Deployment ──────────┘                            ▲
                                                        │
Metrics Server ──> HPA ─────────────────────────────────┘

Runner Job ──> results/checkpoint PVC ──> report generator
Resource-capture script ──> experiment evidence ──> report generator
```

Only simulator Pods autoscale. The HPA uses the simulator Deployment as its `scaleTargetRef`; Locust labels and selectors are separate and are excluded from the HPA target.

The singleton runner generates a deterministic schedule and uses a bounded HTTP worker pool. It appends each accepted simulation result to `results.jsonl` and maintains a compact checkpoint on a ReadWriteOnce PVC. On restart, it reloads the checkpoint and results, ignores completed match IDs, and safely resends only missing work. Because each match ID determines the inputs and seed, a duplicate response is harmless and only one result is accepted.

The runner and Locust resolve the simulator Service through Kubernetes DNS. A Service routes connections across Ready endpoints but does not guarantee strict request-by-request round robin; clients use enough independent connections, and the returned `servedBy` value is used to verify distribution.

The runner remains a singleton because it owns the authoritative checkpoint. Group matches can use its worker pool concurrently. Knockout rounds are barriers: series within one round can run concurrently, but the runner waits for all winners before constructing the next round.

## Tournament rules

### Roster and grouping

- Read the roster from `Dex.mod('gen9').species.all()` in the pinned package.
- Include entries with National Dex numbers 1 through 1,025 where `name === baseSpecies`.
- Assert both roster length and unique National Dex number count are 1,025.
- Sort by National Dex number before shuffling.
- Derive the roster seed from `SHA-256(UTF8(tournamentSeed + "\nroster"))`, interpreting the first eight digest bytes as four unsigned 16-bit big-endian integers.
- Shuffle using the pinned Showdown `PRNG.shuffle`, and save the complete ordered roster as evidence.
- Divide the shuffled full roster, in order, into groups of 257, 256, 256, and 256.

### Battle set

- Format: `gen9customgame`, allowing the synthetic set without claiming that every species can legally learn Metronome.
- One Pokémon per side at level 100.
- IVs: 31 in all six stats.
- EVs: 0 in all six stats.
- Nature: Serious, which is neutral.
- Item: none.
- Move list: Metronome only.
- Ability: the species' primary ability, `species.abilities[0]`.
- Gender: use a species' fixed M/F/N gender; use M for a variable gender ratio.
- Happiness: 255.
- Never select Terastallization.
- Pokémon Showdown chooses the Metronome-called move and resolves the battle mechanics.

### Seeds and side assignment

Every simulation has a unique stable `matchId`, such as `group-A-000001` or `r64-series-03-game-2-attempt-1`. Its Showdown seed is derived as follows:

```text
digest = SHA-256(UTF8(tournamentSeed + "\n" + matchId))
seed = [u16be(digest[0:2]), u16be(digest[2:4]),
        u16be(digest[4:6]), u16be(digest[6:8])]
```

Record the tournament seed, `matchId`, four-number Showdown seed, exact package version, rule version, teams, and choices. A seed alone is not sufficient for reproducibility.

For a group match, use the next digest bit to select the p1 participant. In knockout series, alternate p1 between games. This makes side assignment deterministic and balanced.

### Completion, draws, and errors

- After 100 completed turns, force a tie before accepting choices for a further turn.
- A natural Showdown tie is also a draw.
- An application timeout, stream exception, invalid response, or HTTP failure is an operational error rather than a draw. Retry the same `matchId` and seed up to three times with exponential backoff, then fail the tournament.
- Retain the full input log for failed or sampled battles, but not every full protocol by default.

### Full group stage

For a group of `n`, generate each unordered pair `i < j` exactly once:

- group A: `257 × 256 / 2 = 32,896` battles;
- each other group: `256 × 255 / 2 = 32,640` battles; and
- total: **130,816 group-stage battles**.

Scoring is win = 3 points, draw = 1 point for each participant, and loss = 0. Rank participants by:

1. total points;
2. mini-table points from matches among the tied cohort;
3. total wins;
4. Sonneborn–Berger score, stored as an integer: twice each defeated opponent's final points plus each drawn opponent's final points; and
5. ascending deterministic tie key `SHA-256(tournamentSeed + "\nrank\n" + group + "\n" + speciesId)`.

Save every intermediate tie-break value in the standings output. The top 16 participants from each group advance.

### Full knockout stage

- The round of 64 pairs A with B and C with D. Rank `r` faces rank `17-r` from the paired group, and adjacent series alternate which group supplies the higher seed.
- Do not reseed after a round; winners advance through the fixed recorded bracket.
- A series is first to two decisive wins. Draws do not count as wins and consume the next simulation seed.
- Cap a series at seven total simulations. If neither participant has two wins, advance the participant with more decisive wins; if still tied, use and record a deterministic hash lottery.

The full knockout has 63 series and 126–441 simulations. The complete tournament therefore contains 130,942–131,257 simulations.

### Accepted 32-species sample mode

The runner first supports a fixed, curated roster of 32 species defined in configuration and is not selected from the shuffled full roster. It advances the top four participants from each group and uses a fixed 16-entry knockout bracket.

The sample contains 112 group-stage battles and 15 knockout series. At two to seven simulations per series, it requires approximately 142–217 simulations overall. It uses the same seed derivation, side assignment, scoring, tie-breakers, battle rules, retry rules, and result format as the full tournament.

This mode validates the complete runner, checkpoint, standings, bracket, and reporting pipeline. It does not replace the required 1,025-species tournament.

## Application and API boundary

The service owns the fixed battle rules. Clients provide two valid base species, a `matchId`, and a four-number seed; they cannot submit arbitrary teams, moves, abilities, or formats.

Implemented endpoints are:

- `POST /v1/battles` — validate and simulate one battle;
- `GET /health/live` — confirm that the HTTP process is alive; and
- `GET /health/ready` — confirm that the pinned Dex is loaded and the species and move-count contracts pass.

The API uses camelCase field names. The intended final battle response contains:

- `matchId`;
- `pokemon1` and `pokemon2`;
- `outcome`;
- `winnerSide`;
- `winnerSpecies`;
- `turns`;
- `termination`;
- `seed`;
- `simulatorVersion`;
- `protocolHash`;
- `servedBy`; and
- `durationMs`.

## Results, experiment evidence, and report interface

The runner owns tournament execution state and writes these canonical machine-readable artifacts to the PVC:

- `run-metadata.json`: seed, rule version, dependency and image versions, timestamps, and completion state;
- `results.jsonl`: one immutable record per accepted simulation;
- `standings.json`: group scores and every tie-break value;
- `bracket.json`: bracket positions, series simulations, and winners.

The separate [resource-capture script](../scripts/capture-resource-usage.sh), not the runner, owns experiment observations. The current script writes `resources.csv` and `replicas.csv`; the acceptance-evidence workflow combines those observations with the exported Locust results into `autoscaling-timeline.csv`. This timeline and its source Kubernetes observations are collected only during dedicated Locust/HPA runs. A normal tournament run does not implicitly run a load experiment.

The report generator combines the tournament artifacts with separately captured experiment evidence and produces a self-contained `report.html` with embedded data, CSS, and JavaScript. It works offline after being copied into the repository and has no CDN dependency. Regeneration from identical inputs produces substantively identical content apart from an explicitly labelled generation timestamp.

The report provides a run summary, sortable group tables with advancement cutoffs, the knockout bracket and series details, a searchable simulation table, and an autoscaling chart aligned with request rate, latency, and failures. It is read-only and never becomes the source of truth.

### Deferred Pokémon Showdown replay viewer

After the 32-species sample tournament, restart/resume validation, and offline report are complete, perform a bounded viability spike for a separate read-only replay viewer. A user should be able to search for a matchup, select a recorded simulation, and watch it turn by turn using the actual Pokémon Showdown battle UI rather than only reading a move log or final result.

The viewer does not require a database or a second simulation engine. For a selected `matchId`, the system reloads the canonical participants, seed, rule version, and simulator version from the tournament artifacts, re-simulates the battle with the same fixed teams and player choices, verifies the winner, turn count, termination, and `protocolHash` against the stored result, and passes the regenerated battle protocol to a pinned Pokémon Showdown client replay player.

Full replay protocols are not stored for every simulation by default. They are regenerated on demand, while sampled or explicitly requested replay logs may be retained as evidence. `results.jsonl` remains the authoritative tournament record, and a replay mismatch is treated as a reproducibility failure rather than replacing the stored result.

The required `report.html` remains self-contained and usable offline without the viewer. The replay viewer is a separate optional interface and may use a locally served simulator plus explicitly pinned client assets. Its viability spike must identify the client commit, required sprite and animation assets, browser delivery path, and licensing obligations; the Pokémon Showdown client is AGPLv3 even though the simulator package is MIT-licensed. The first spike needs to prove only that one recorded battle renders with working replay controls and agrees with the stored result. If that integration is impractical, the viewer remains deferred and does not block any required lab deliverable.

## Container and Pod security

The simulator image and Pod implement the following controls:

- process UID and GID are both 1000;
- `runAsNonRoot: true`;
- `RuntimeDefault` seccomp profile;
- privilege escalation disabled;
- all Linux capabilities dropped;
- read-only root filesystem;
- explicit CPU and memory requests and limits; and
- startup, readiness, and liveness probes.

Before every acceptance run, validate that every lab-owned regular and init container declares CPU and memory requests and limits. Resource values currently used for experiments are provisional until the right-sizing phase is complete.

## Probe behaviour and acceptance risk

Exploratory tests show that battle processing can saturate the Node.js process and delay HTTP probe responses. Under saturation, the current HTTP liveness probe can restart a busy but still living simulator Pod. Readiness correctly removes an unresponsive endpoint, but liveness-triggered restarts can amplify the failure by reducing serving capacity and repeating startup work.

The final liveness behaviour must be revised and validated before HPA acceptance testing. The design deliberately does not prescribe the final probe configuration until that experiment is complete.

## In-cluster Locust design

Locust runs as one fixed-replica Deployment in the `load-testing` namespace and sends requests directly to the simulator through Kubernetes Service DNS. It declares explicit CPU and memory requests and limits and is not autoscaled.

Every acceptance experiment captures Locust resource usage alongside simulator and cluster metrics. The exploratory evidence shows that Locust remained well below its limits while the simulator saturated, supporting CPU saturation in the simulator as the leading constraint in those runs.

Locust's requests count toward cluster scheduling capacity. For the capacity-limited experiment, it must either be scaled down or be explicitly included in the free-capacity calculation.

Locust profiles cover idle, sustainable steady load, a spike held for multiple metrics collection intervals, and recovery. Capture synchronized timestamps, desired/current/ready simulator replicas, per-Pod CPU and memory, Locust resources, request rate, failures, and p50/p95 latency. Very short spikes are not valid evidence because Metrics Server and the HPA reconcile periodically.

## Exploratory scaling evidence

> Scaling from one to three fixed simulator replicas nearly tripled useful processing capacity and substantially reduced latency and failure rate. All three replicas still reached their CPU limits and restarted, so these results demonstrate horizontal scalability but are not final right-sizing or HPA acceptance evidence.

Under the same 50-user, three-minute profile, Locust total RPS increased from 13.7 to 37.7. Accounting for failed requests, successful throughput increased from approximately 12.3 to 36.9 requests per second—nearly threefold. Failure rate fell from 10.0% to 2.1%, median latency fell from 1.5 seconds to 790 milliseconds, and p95 latency fell from 19 seconds to 2.2 seconds. See the [baseline experiment](baseline-experiment.md) and [three-Pod experiment](three-pod-experiment.md) for the measurements and source artifacts.

The fixed-replica runs establish that horizontal scaling can add useful processing capacity. Because CPU saturation, readiness loss, and restarts remained, they do not establish a healthy operating point or validate an HPA configuration.

## HPA and resource-sizing design

Battle simulation is CPU-bound, stateless, and independently reproducible. A Node.js process executes JavaScript on one main event loop, so additional simulator Pods allow the cluster to use additional cores. Experiments showed simulator CPU saturation while memory remained below the 512 Mi limit, making CPU the leading HPA metric. The current 128 Mi memory request remains provisional.

CPU `averageUtilization` is measured as a percentage of the container's CPU request rather than its limit. Kubernetes calculates the raw recommendation approximately as:

```text
desiredReplicas = ceil(currentReplicas × currentUtilization / targetUtilization)
```

CPU requests are therefore required for utilization-based scaling, and choosing them is part of the control design rather than a cosmetic resource setting. See the Kubernetes documentation for the [HPA algorithm](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/) and [container resources](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/).

Final CPU and memory requests, limits, CPU target, minimum replica count, and maximum replica count have not been selected. Values used in exploratory manifests, including a 100m CPU request, 500m CPU limit, or any experimental HPA bounds and targets, are provisional.

The final choices follow these measurements and constraints:

- establish sustainable per-Pod load before selecting CPU requests;
- define healthy operation using latency, failure rate, readiness, and restart behaviour, not CPU alone;
- choose a CPU target below the utilization point at which service degradation begins;
- set minimum replicas from the selected availability objective;
- set maximum replicas from cluster allocatable capacity and measured healthy per-Pod throughput; and
- continue the recovery observation beyond the configured scale-down stabilization window to demonstrate delayed scale-in and a stable return to minimum capacity.

Measure one Pod under idle, steady, and increasing load for a representative duration. Use observed CPU, memory, throttling, latency, failures, readiness, and restarts to choose a sustainable operating point and appropriate headroom. Then compare a fixed one-Pod baseline with an HPA run using the same image, requests and limits, deterministic request corpus, client concurrency, and duration.

Acceptance evidence must show more than a replica-count change: requests must reach new Ready Pods, useful throughput or latency must improve or remain healthy, failures and restarts must remain acceptable, and replicas must scale down after load ends. Aggregate the response `servedBy` values by time bucket and correlate them with EndpointSlices, Deployment and HPA events, Pod placement, and per-Pod CPU.

## Metrics Server

Metrics Server `v0.8.0` is installed from its vendored upstream `components.yaml` using Kustomize. The local overlay applies `--kubelet-insecure-tls` because the Docker Desktop kubelet serving certificate failed validation. The [installation documentation](../k8s/addons/metrics-server/README.md) records the local-only rationale, but the repository does not yet contain the original error output. The exact certificate-validation error must be captured in the evidence package before the final audit; until then, the design does not claim that raw TLS failure evidence is retained.

Disabling kubelet certificate validation is acceptable only in this local, single-user lab. A production or shared cluster must use trusted kubelet serving certificates. Metrics Server `0.8.x` supports Kubernetes `1.31+`, including this Kubernetes `v1.36.1` cluster; see the upstream [compatibility matrix](https://github.com/kubernetes-sigs/metrics-server#compatibility-matrix).

## VPA comparison

VPA remains a pending recommendation-only comparison. Configure it with `updateMode: "Off"`, collect representative idle and loaded history, and compare its `lowerBound`, `target`, and `upperBound` with the manually selected requests.

VPA must not mutate the CPU requests while a CPU-utilization HPA controls the same workload. Changing the request changes the HPA utilization denominator and creates interacting feedback loops. Recommendation-only mode allows an evidence-based comparison without changing running Pods. See the upstream [VPA API](https://github.com/kubernetes/autoscaler/blob/master/vertical-pod-autoscaler/docs/api.md) and [known limitations](https://github.com/kubernetes/autoscaler/blob/master/vertical-pod-autoscaler/docs/known-limitations.md).

## Scheduling and capacity demonstration

Simulator Pods may be spread across the three schedulable workers; the tainted control-plane node is unavailable to ordinary application Pods. A soft topology-spread constraint may encourage distribution without making normal scheduling brittle. Kubernetes schedules Pods to nodes; the ClusterIP Service then routes client connections to Ready simulator endpoints.

The capacity demonstration must produce scheduler-level Pending Pods with events that include `FailedScheduling` and `Insufficient cpu`. It must not use a ResourceQuota that turns the result into an admission-time `FailedCreate` failure.

Create an isolated capacity-demo overlay targeting the three schedulable workers. Let `L` be the largest eligible worker's allocatable CPU and choose a demo request `q > L / 2`, which prevents any eligible node from fitting two demo Pods. Confirm that `q` is no greater than the smallest eligible worker's free requested CPU so one demo Pod can fit on each worker. Then request four replicas: one more than the three-worker capacity under that constraint.

If those bounds do not overlap because the nodes are heterogeneous or already busy, select a homogeneous worker subset with node affinity and repeat the calculation for that subset. Record allocatable resources, existing requests—including Locust unless it has been scaled down—the calculation, Pod conditions, and scheduler events.

Requests drive scheduling and an unsatisfied request leaves a Pod Pending; limits are runtime enforcement. See [Kubernetes resource management](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/). Docker Desktop has fixed local nodes and no cloud-provider node-group API that a cluster autoscaler could use to add a VM; contrast this with [Kubernetes node autoscaling](https://kubernetes.io/docs/concepts/cluster-administration/node-autoscaling/).

## Cost and performance requirement

The Docker Desktop cluster has no defensible cloud node charge, so local measurements and cloud estimates remain clearly separated. At project completion, report:

- a right-sized monthly cloud estimate;
- a monthly estimate for the same workload at 2× over-provisioning;
- the additional monthly cost of that over-provisioning; and
- the observed latency, failure-rate, readiness, and restart/availability risk caused by under-provisioning.

For each estimate, identify the provider, region, instance type, billing unit, utilization assumptions, required node count, fixed service charges, and the date of the cited official price. Use a consistent monthly-hours assumption and show the arithmetic.

Cost per 1,000 battles remains supplementary:

```text
estimatedRunCost =
  averageNodeCount × instanceHourlyPrice × elapsedHours
  + proratedFixedServiceCosts

costPer1000Battles = estimatedRunCost / completedBattles × 1,000
```

Compare cost with throughput, p95 latency, failure rate, and availability. Additional simulator replicas consume cluster capacity but add cloud cost only when they cause additional billed infrastructure or service usage.

## Required deliverables

The final audit package is complete only when it contains all of the following:

- [ ] an HPA manifest plus observed scale-out and scale-in evidence;
- [ ] a VPA Off-mode manifest plus captured recommendation evidence;
- [ ] the in-cluster Locust workload plus exported acceptance-test results;
- [ ] a capacity demonstration with a scheduler-level Pending Pod and `Insufficient cpu` diagnosis;
- [ ] the final offline report interface combining tournament results and separately captured experiment evidence; and
- [ ] a README explaining resource sizing, HPA/VPA interaction, capacity diagnosis, approximate monthly cost, and complete reproduction instructions.

## Current risks and validation gates

| Risk | Effect | Validation or control |
| --- | --- | --- |
| Pinned stream assumptions drift | Incorrect result parsing or request routing | Exact dependency and lockfile; deterministic replay and contract tests |
| Pinned engine has vulnerable or deprecated transitive packages | Known dependency findings remain in the runtime dependency tree | Keep the engine version pinned for reproducibility, save the current 11-finding audit output, limit container exposure and privileges, and evaluate upgrades separately; do not apply `npm audit fix --force` because forced changes could alter behaviour and reproducibility |
| Full group stage contains 130,816 battles | Runtime and evidence volume can obscure infrastructure work | Validate the same pipeline with the accepted 32-species mode, then run all 1,025 species |
| CPU-bound processing delays probes | Busy but living Pods restart and reduce serving capacity | Revise and test liveness behaviour before HPA acceptance |
| Keep-alive skews Service distribution | One Pod may be hot while others are underused | Use independent connections and analyze `servedBy` distribution |
| A wall timeout changes outcomes under load | Identical deterministic input could appear inconsistent | Treat timeouts as retryable operational failures; only turn count determines a capped draw |
| Startup work distorts samples | Sizing and HPA choices include non-steady behaviour | Gate traffic on readiness and separate warm-up from measurement |
| VPA has insufficient history | Recommendation is not representative | Collect both idle and sustained-load history and report the sampling period |
| Locust consumes schedulable capacity | Capacity experiment attributes the wrong constraint | Scale Locust down or include its requests in the calculation |
| Replay viewer integration expands scope or mishandles upstream assets | Optional UI work delays required lab evidence or creates licensing and compatibility risk | Start only after the sample-tournament phase gate; prove one replay in a bounded spike; pin the client revision and document AGPLv3 and asset requirements before integration |

## Phase status

The current implementation state is:

- phases 1–4 complete;
- Metrics Server completed early;
- exploratory fixed-replica testing completed early;
- phase 5 active;
- the optional replay-viewer spike deferred until after the phase 5 sample-tournament gate; and
- phases 6–10 pending.

The remaining phase gates are:

1. **Environment inventory — complete.** The accepted cluster facts are reflected in this design.
2. **Pinned simulator contract — complete.** Deterministic battle and catalog contracts are tested.
3. **Local HTTP service — complete.** Battle, liveness, readiness, and validation paths are implemented.
4. **Container and single-Pod Kubernetes path — complete.** The secured simulator Deployment and ClusterIP Service run in Kubernetes.
5. **Runner, PVC, sample tournament, and report — active.** Complete the 32-species tournament end to end, validate restart/resume, and open the generated report offline.
6. **Measure and right-size — pending.** Establish the sustainable one-Pod operating point and select resource values.
7. **HPA acceptance evidence — pending; Metrics Server and exploratory comparison completed early.** Select the HPA values, then capture steady load, scale-out, service health, and recovery through scale-down.
8. **VPA recommendation comparison — pending.** Collect and compare Off-mode recommendations.
9. **Capacity and scheduler diagnosis — pending.** Produce a scheduler-level `Insufficient cpu` Pending Pod using calculated requests.
10. **Final run and audit package — pending.** Run all 1,025 species and assemble the final manifests, evidence, cost comparison, report, and reproducibility instructions.

After the phase 5 exit condition is satisfied, the optional replay-viewer viability spike may run as a separate enhancement. It is not an assignment deliverable or a prerequisite for phases 6–10.

At project completion, replace this progress section and the opening status with a clean description of the implemented final design and its accepted results.
