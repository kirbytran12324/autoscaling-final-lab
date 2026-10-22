# Codebase hardening and validation

This change preserves the prepared Terraform reference, managed operator
authentication and isolated local resilience overlay, then addresses the code
review's correctness and validation findings. It does not provision infrastructure,
configure a cloud identity, deploy an application or start a tournament.

## Application changes

- Control requests and Kubernetes JSON/log responses decode complete UTF-8 byte
  sequences. Splitting a Unicode tournament seed across network chunks no longer
  changes its value. Existing request and response byte limits remain enforced.
- Kubernetes list calls follow bounded pages and continuation tokens. Oversized
  pages restart with smaller limits; incomplete collections are never returned.
  The managed-history API shape is unchanged and no records are deleted.
- Control mutations and polling ignore responses for an obsolete selection or
  request generation. Standings and battle pages can retry the same failed query.
- Invalid replay asset configuration preserves readable names, reports, controls
  and verified logs while displaying a configuration warning. It never enables
  the player with an invalid URL or falls back to public Showdown asset servers.
- Native Windows runner tests use filesystem basename handling. Directory-junction
  security coverage runs on Windows; the external-file symlink case skips only
  when Windows lacks the required privilege and remains mandatory on Linux.
- Battle and replay routes share bounded per-replica admission, explicit `503`
  overload responses and queued-client cancellation. See the
  [simulator API contract](api-contract.md#simulator-admission-and-overload).

## Delivery changes

The delivery checks add Windows native test coverage, locked-provider mocked
Terraform tests, lifecycle guard tests and strict pinned Kubernetes schemas.
Custom-resource schema exceptions are explicit and require installed-controller
validation before use. The PostSync smoke now validates a known deterministic
battle in addition to health endpoints.

Publishing images and observing a deployed revision remain separate statuses.
The opt-in development observer requires an already configured dedicated runner
and read-only context; it checks the exact promoted Git revision, image digest,
rollout and matching successful PostSync smoke. It does not apply or sync
resources. See [delivery verification](delivery-verification.md) for configuration,
commands, schema exceptions and recovery guidance.

## Remaining operational work

- Run the affected Linux production images and packaged Nginx checks in CI. Local
  Docker Desktop was stopped during this change; local Node/browser checks do
  not prove container behavior.
- Exercise admission, CPU throttling, readiness, liveness and recovery under
  sustained Kubernetes load before changing probe budgets. A single CPU-bound
  battle still shares the Node event loop with HTTP handling. Historical
  autoscaling evidence predates admission limits and is not new acceptance data.
- Configure and exercise deployment observation on the intended local runner.
  Fixture tests cannot prove access, live Argo status or controller behavior.
- Retained registry collections still consume memory proportional to their size.
  Design explicit registry retention and public API pagination separately from
  immutable completed-archive retention.
- Cold archive validation/index construction, search debounce and lazy battle
  loading remain performance follow-ups. Preserve strict validation before
  serving evidence; do not skip it to improve response time. The review measured
  roughly 1.3 seconds cold load and 377 MiB peak RSS for a 130,975-match archive,
  while cached pagination was about 2 ms at p95 on the local Windows runtime.

Experiment captures and daily audit reports remain local rather than entering
the feature branch. Runtime state, Terraform plans/providers, dependency trees,
generated frontend output and downloaded asset snapshots are excluded from Git.
