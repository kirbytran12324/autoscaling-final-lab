# Tournament Runner State Contract

Status: accepted phase 5 persistence and recovery contract.

This contract defines which runner artifacts are authoritative, when a battle is accepted, and how the singleton runner resumes after its Pod restarts. The tournament rules and architecture remain authoritative in [technical-design.md](technical-design.md).

## Persistent artifacts

The runner uses one PVC as a state root and retains each tournament in its own
directory:

```text
<stateRoot>/runs/<runId>/
  run-metadata.json
  results.jsonl
  checkpoint.json
  standings.json
  bracket.json
```

Each run ID names exactly one run directory. Historical run directories remain
on the PVC and are not reused or modified when a different run ID is selected.
At any time, the singleton runner writes only the selected run directory; it
does not coordinate concurrent writers to multiple runs or to the same run.
Recovery is permitted only when the selected directory contains valid metadata
whose immutable run identity exactly matches the requested run. A directory
that contains only temporary `run-metadata.json` files matching the state
writer's atomic-write naming convention may be initialized after an interrupted
first metadata write. Unknown files or canonical evidence without
`run-metadata.json` are orphaned state and must be preserved for diagnosis
rather than initialized over.

The paths in the following table are relative to the selected run directory.

| File | Purpose | Write model |
| --- | --- | --- |
| `run-metadata.json` | Identifies the run, tournament seed, rule and dependency versions, mode, timestamps, and completion state | Atomic replacement |
| `results.jsonl` | Append-only authoritative record of accepted simulations | Append one newline-terminated record, then flush it before advancing the checkpoint |
| `checkpoint.json` | Records the current stage, round, and schedule position so normal resume is efficient | Atomic replacement |
| `standings.json` | Derived provisional or final group standings and every tie-break value | Atomic replacement at a bounded periodic cadence during group play and after the complete final calculation |
| `bracket.json` | Derived knockout positions, series simulations, and winners | Atomic replacement at knockout-round barriers |

`standings.json` uses this versioned wrapper:

```json
{
  "schemaVersion": 1,
  "runId": "sample-2026-09-10",
  "status": "provisional",
  "acceptedResultCount": 10,
  "expectedResultCount": 112,
  "advancingCount": 4,
  "updatedAt": "2026-09-10T01:02:03.000Z",
  "groups": []
}
```

`groups` always contains the four existing group-standing results in A, B, C,
D order. Each result retains its `group`, provisional or final `status`,
completed and expected match counts, and ranked `standings` entries with all
tie-break values. Sample runs replace this artifact after each absolute
multiple of 10 accepted group results, while full runs use multiples of 1,000.
The runner also writes a mandatory final artifact after every scheduled group
match is accepted.

The initial `bracket.json` written at the group-to-knockout barrier uses this
wrapper:

```json
{
  "schemaVersion": 1,
  "runId": "sample-2026-09-10",
  "status": "running",
  "rounds": [
    {
      "round": "r16",
      "series": []
    }
  ],
  "champion": null,
  "updatedAt": "2026-09-10T01:02:03.000Z"
}
```

The first `rounds` entry is the unmodified initial round returned by the
tournament bracket builder: `r16` with eight series in sample mode or `r64`
with 32 series in full mode. Later runner slices append later rounds and
eventually replace `champion`; this transition does neither.

`results.jsonl` is the source of truth for whether a `matchId` is complete after
the record has been validated against the deterministic schedule. The
checkpoint is only a progress hint and must never override an accepted result.
The state layer parses persisted records, rejects conflicting duplicates, and
returns one canonical accepted record per `matchId`; it does not infer schedule
progress from the number of JSONL records. The lifecycle loader exposes these
as `acceptedRecords` and the optional `checkpointHint`; raw JSONL records are
not part of its downstream return value.

During knockout play, `schedulePosition` is the number of accepted games in
the currently reconstructed `round`. It resets to zero when a completed-round
barrier constructs the next round. `acceptedResultCount` remains the total
number of authoritative accepted simulations across the group and knockout
stages. Both values are progress hints and never override `results.jsonl`.

Provisional standings are derived from the currently accepted records in
`results.jsonl`. Their points, mini-table values, and Sonneborn–Berger values
represent that result set and may change as more matches are accepted. A
provisional snapshot is never an advancement input: only a complete final
group standing, with every unordered pair present exactly once, may select
advancing participants.

The runner atomically replaces `standings.json` with bounded provisional
snapshots after each absolute multiple of 10 accepted group results in sample
mode or 1,000 in full mode. On recovery at a cadence boundary, it rewrites the
reconciled group checkpoint and snapshot before assigning more work. Snapshot
writes do not introduce round barriers.

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
At a completed-round barrier, each completed series uses this representation:

```json
{
  "seriesId": "r16-series-01",
  "position": 1,
  "entrant1": {},
  "entrant2": {},
  "games": [
    {
      "gameNumber": 1,
      "matchId": "r16-series-01-game-01"
    }
  ],
  "evaluation": {
    "seriesId": "r16-series-01",
    "status": "complete",
    "gamesPlayed": 2,
    "entrant1Wins": 2,
    "entrant2Wins": 0,
    "draws": 0,
    "nextGameNumber": null,
    "winner": {},
    "resolution": "two-wins",
    "lotteryHash": null
  }
}
```

The abbreviated entrant, game, and winner objects above retain all fields from
their deterministic tournament or accepted-result representations. `games`
is in ascending `gameNumber` order and includes accepted draws. Previously
completed rounds retain this enriched form. The next round is appended in the
raw form returned by `buildNextKnockoutRound` and is not enriched until its own
completed-round barrier.

At each completed-round barrier, its next-round entrants retain their original
group and rank and record the immediately preceding series they won in
`sourceSeriesId`.
The champion stored in `bracket.json` is derived from the authoritative
accepted `r2-series-01` game records and is not a separate mutable source of
truth.

If seven accepted games leave the entrants tied on decisive wins, derive and
record the complete lowercase hexadecimal `lotteryHash` as
`SHA-256(UTF8(tournamentSeed + "\n" + seriesId + "-lottery"))`. The most
significant bit of the first digest byte selects `entrant1` for bit 0 and
`entrant2` for bit 1.

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

On startup or restart, the state layer:

1. loads and validates the run metadata;
2. reads every complete record from `results.jsonl` and builds the completed-`matchId` index;
3. rejects conflicting duplicate IDs or malformed persisted evidence;
4. returns one canonical accepted record per `matchId`; and
5. loads and returns the checkpoint, when present, as an unmodified progress hint.

For a running tournament, the tournament runner then generates the
deterministic schedule, validates the canonical records against it, and only
then reconciles checkpoint position and counts, recomputes standings, skips
completed matches, and resends missing work. A `completed` or `failed` run is
terminal read-only history: the state layer does not synthesize or rewrite its
checkpoint, and a failed run is not implicitly resumed.

A crash before the result append causes the missing deterministic request to be sent again. A crash after the append but before the checkpoint update leaves the checkpoint behind, but the accepted `matchId` in `results.jsonl` prevents a duplicate result. A malformed or truncated persisted record is never silently discarded; automatic resume stops and preserves the PVC for diagnosis.

After all series in a non-final knockout round are complete, the runner first
atomically writes the complete `bracket.json`, including the enriched completed
round and the next deterministic raw round. Only after that bracket is durable
does it write the next-round knockout checkpoint with `schedulePosition: 0`.
It does not execute the next round in the same call. Recovery repeats these
derived writes when the accepted results prove that the round completed but
the checkpoint has not crossed the round barrier.

After `r2` is complete, the runner first writes the completed bracket with its
enriched final series and derived champion, then writes the `stage: "complete"`
checkpoint, and finally writes `run-metadata.json` with `status: "completed"`
and `completedAt`. Until that final metadata write is durable, recovery exposes
the result-complete final as pending knockout finalization so the same derived
writes can be repeated without executing another game.

The other JSON state files use the same temporary-file, flush, and atomic-rename pattern. Temporary files must be created on the same PVC as their destination so the rename stays within one filesystem. A prior `standings.json` snapshot is derived evidence and never overrides standings recomputed from authoritative `results.jsonl` records after restart.

## Deferred replay viewer

The canonical result records retain the participants, seed, rule version, simulator version, and deterministic result fields needed to reproduce a battle. After the 32-species sample tournament, restart/resume validation, and offline report are complete, an optional replay command may re-simulate a selected `matchId`, verify its winner, turn count, termination, and `protocolHash`, and emit protocol for a pinned Pokémon Showdown client replay player.

Replay protocols are generated on demand rather than stored for every simulation. Sampled or explicitly requested logs may be retained as evidence, but they do not replace `results.jsonl` as the tournament source of truth. Replay-viewer work is not part of the lab acceptance criteria and must not block the phase 5 exit condition.
