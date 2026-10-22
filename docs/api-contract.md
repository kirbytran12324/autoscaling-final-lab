# Simulator API Contract

## `POST /v1/battles`

Runs one deterministic Pokémon battle.

### Request

```json
{
  "matchId": "group-001",
  "pokemon1": "Snorlax",
  "pokemon2": "Clefable",
  "seed": [12345, 23456, 34567, 45678],
  "maxTurns": 100
}
```

`maxTurns` is optional and defaults to `100`. All other fields are required.

### Successful response — `200 OK`

```json
{
  "matchId": "group-001",
  "pokemon1": "Snorlax",
  "pokemon2": "Clefable",
  "outcome": "win",
  "winnerSide": "p1",
  "winnerSpecies": "Snorlax",
  "turns": 6,
  "termination": "natural",
  "seed": [12345, 23456, 34567, 45678],
  "simulatorVersion": "pokemon-showdown@0.11.11",
  "protocolHash": "64-character SHA-256 value",
  "servedBy": "simulator-pod-name",
  "durationMs": 12.34
}
```

`servedBy` is the hostname reported by the process that handled the battle. By
itself, it proves only response attribution to the reported hostname. Phase 7
establishes that traffic reached each Ready replica by reconciling those values
with the captured Pod and EndpointSlice evidence.

### Invalid request — `400 Bad Request`

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Explanation of the invalid field"
  }
}
```

## `GET /health/live`

Confirms that the HTTP server process is running.

### Response — `200 OK`

```json
{
  "status": "ok"
}
```

## `GET /health/ready`

Confirms that the Pokémon Showdown engine data loaded successfully with the
expected tournament invariants and that the local admission queue has capacity.
It returns `503` with `status: "not-ready"` while that queue is full. Liveness
continues to report process health independently of admission capacity.

### Response — `200 OK`

```json
{
  "status": "ready",
  "speciesCount": 1025,
  "metronomeMoveCount": 581
}
```

## Simulator admission and overload

Both battle routes share a bounded, per-replica execution budget. The defaults
are two concurrent simulations and eight queued simulations. Configure these
with `SIMULATOR_MAX_CONCURRENT_BATTLES` (positive integer) and
`SIMULATOR_MAX_QUEUED_BATTLES` (non-negative integer, including zero for immediate
rejection when busy). Invalid values stop startup. Increasing replica count
adds independent capacity without changing seeds or tournament results.

When capacity is full, valid battle requests receive `503`, `Retry-After: 1`,
and error code `SIMULATOR_BUSY`. Retry the same match ID, participants and seed;
overload is never a draw or an accepted result. The existing runner retries
operational failures using its bounded retry policy. Disconnected queued
requests are removed; already executing simulations retain their slot until
they finish, and their abandoned responses are discarded.
`durationMs` continues to measure execution time after admission, excluding
queue wait; client-observed latency also includes that wait and transport time.

Queued batches yield to the event loop between executions. This limits backlog
and lets health requests run between batches, but does not isolate a single
CPU-bound battle from the HTTP event loop. Container CPU throttling, probe
latency, throughput and recovery still require a sustained Kubernetes load test
before changing probe budgets or claiming new autoscaling acceptance evidence.
The historical load-test results predate this admission policy.
