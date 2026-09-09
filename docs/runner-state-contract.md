# Tournament Runner State Contract

Status: accepted phase 5 persistence and recovery contract.

This contract defines which runner artifacts are authoritative, when a battle is accepted, and how the singleton runner resumes after its Pod restarts. The tournament rules and architecture remain authoritative in [technical-design.md](technical-design.md).

## Persistent artifacts

| File | Purpose | Write model |
| --- | --- | --- |
| `run-metadata.json` | Identifies the run, tournament seed, rule and dependency versions, mode, timestamps, and completion state | Atomic replacement |
| `results.jsonl` | Append-only authoritative record of accepted simulations | Append one newline-terminated record, then flush it before advancing the checkpoint |
| `checkpoint.json` | Records the current stage, round, and schedule position so normal resume is efficient | Atomic replacement |
| `standings.json` | Derived provisional or final group standings and every tie-break value | Atomic replacement at a bounded periodic cadence during group play and after the complete final calculation |
| `bracket.json` | Derived knockout positions, series simulations, and winners | Atomic replacement at knockout-round barriers |

`results.jsonl` is the source of truth for whether a `matchId` is complete. The checkpoint is a progress aid and must never override an accepted result.

Provisional standings are derived from the currently accepted records in
`results.jsonl`. Their points, mini-table values, and Sonneborn–Berger values
represent that result set and may change as more matches are accepted. A
provisional snapshot is never an advancement input: only a complete final
group standing, with every unordered pair present exactly once, may select
advancing participants.

The runner may atomically replace `standings.json` with bounded periodic
provisional snapshots during group play. The exact snapshot cadence belongs to
the later runner implementation and must not introduce round barriers.

## Accepting a simulation result

Before appending a response, the runner validates that:

- `matchId`, `pokemon1`, and `pokemon2` match the request;
- the returned four-number `seed` exactly matches the requested seed;
- `simulatorVersion` is the expected pinned version;
- `outcome`, `winnerSide`, and `winnerSpecies` are present and internally consistent;
- `turns` and `termination` are valid for the fixed battle rules;
- `protocolHash` is a 64-character SHA-256 value; and
- `servedBy` is a non-empty simulator process or Pod identifier.

An invalid response, HTTP failure, application timeout, or stream failure is an operational error. The runner does not append it. It retries the same `matchId`, participants, and seed up to three times with exponential backoff, then marks the tournament failed.

Every accepted knockout simulation is called a game. Its stable `matchId`
uses a two-digit suffix such as `r64-series-03-game-02`. Operational retries
reuse the same game ID, participants, and seed; retry numbers appear only in
runner logs or metadata and never in `matchId`. A draw consumes the current
game, so continued series play uses the next game ID and its derived seed.
`bracket.json` retains accepted games, including draws, but excludes failed
HTTP attempts. Each accepted game records its game number, match ID,
participants, seed, outcome and winner, turns, termination, and protocol hash.

## Deterministic replay fields

For identical battle inputs and the same rule and simulator versions, these fields must reproduce exactly:

- `matchId`;
- `pokemon1` and `pokemon2`;
- `seed`;
- `simulatorVersion`;
- `outcome`;
- `winnerSide` and `winnerSpecies`;
- `turns`;
- `termination`; and
- `protocolHash`.

`servedBy` and `durationMs` are operational observations and may differ between executions. A repeated `matchId` with identical deterministic fields is harmless and is not appended twice. A repeated `matchId` with conflicting inputs or deterministic fields is a reproducibility failure and stops the run.

## Commit and recovery order

For each accepted simulation, the runner:

1. validates the response against the scheduled request;
2. appends exactly one newline-terminated JSON record to `results.jsonl` and flushes it;
3. updates in-memory tournament state; and
4. writes the new checkpoint through a temporary file in the same directory, flushes it, and atomically renames it over `checkpoint.json`.

On startup or restart, the runner:

1. loads and validates the run metadata;
2. reads every complete record from `results.jsonl` and builds the completed-`matchId` index;
3. rejects conflicting duplicate IDs or malformed persisted evidence;
4. loads the checkpoint as a progress hint;
5. reconciles it with the authoritative results; and
6. recomputes provisional or final standings from `results.jsonl`; and
7. skips completed matches and resends only missing work.

A crash before the result append causes the missing deterministic request to be sent again. A crash after the append but before the checkpoint update leaves the checkpoint behind, but the accepted `matchId` in `results.jsonl` prevents a duplicate result. A malformed or truncated persisted record is never silently discarded; automatic resume stops and preserves the PVC for diagnosis.

The other JSON state files use the same temporary-file, flush, and atomic-rename pattern. Temporary files must be created on the same PVC as their destination so the rename stays within one filesystem. A prior `standings.json` snapshot is derived evidence and never overrides standings recomputed from authoritative `results.jsonl` records after restart.

## Deferred replay viewer

The canonical result records retain the participants, seed, rule version, simulator version, and deterministic result fields needed to reproduce a battle. After the 32-species sample tournament, restart/resume validation, and offline report are complete, an optional replay command may re-simulate a selected `matchId`, verify its winner, turn count, termination, and `protocolHash`, and emit protocol for a pinned Pokémon Showdown client replay player.

Replay protocols are generated on demand rather than stored for every simulation. Sampled or explicitly requested logs may be retained as evidence, but they do not replace `results.jsonl` as the tournament source of truth. Replay-viewer work is not part of the lab acceptance criteria and must not block the phase 5 exit condition.
