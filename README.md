# Metronome Tournament Autoscaling Lab

This repository contains a deterministic Pokémon Metronome simulator, a
restart-safe singleton tournament runner, Kubernetes and load-test manifests,
and an offline tournament report generator. The architecture and tournament
rules are defined in [docs/technical-design.md](docs/technical-design.md).

## Generate an offline tournament report

Use an already completed run. From `simulator/`:

```sh
TOURNAMENT_STATE_ROOT=/path/to/tournament-state \
TOURNAMENT_RUN_ID=sample-32-001 \
npm run report
```

The command validates all canonical run artifacts and atomically writes:

```text
<TOURNAMENT_STATE_ROOT>/runs/<TOURNAMENT_RUN_ID>/report.html
```

Optional evidence directories can be supplied without changing tournament
state:

```sh
REPORT_RESTART_EVIDENCE_DIR=/path/to/restart-evidence \
REPORT_AUTOSCALING_EVIDENCE_DIR=/path/to/autoscaling-evidence \
TOURNAMENT_STATE_ROOT=/path/to/tournament-state \
TOURNAMENT_RUN_ID=sample-32-001 \
npm run report
```

Restart evidence must contain the current harness `summary.txt` and
`checkpoint-before-interruption.json` for the selected run. Autoscaling
evidence may contain a compatible `autoscaling-timeline.csv` with timestamp,
replica, request-rate, p95-latency, and failure columns. When optional evidence
is absent, the report shows explicit placeholders and does not invent values.

The resulting HTML is self-contained and can be opened through `file://`; it
uses no CDN, external font, stylesheet, script, framework, or network request.
`results.jsonl` remains authoritative, and `report.html` is read-only derived
output that may be regenerated. Sample mode validates the 32-species pipeline
but does not replace the required full 1,025-species tournament.

## Test

```sh
cd simulator
npm test
```
