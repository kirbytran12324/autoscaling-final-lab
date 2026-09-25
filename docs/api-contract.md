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

Confirms that the Pokémon Showdown engine data loaded successfully with the expected tournament invariants.

### Response — `200 OK`

```json
{
  "status": "ready",
  "speciesCount": 1025,
  "metronomeMoveCount": 581
}
```
