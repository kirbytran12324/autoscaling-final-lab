# Pipeline and Azure readiness audit

Scope: application delivery, container packaging, Kubernetes configuration,
read-only explorer, and the tournament persistence path in this worktree.
This is a task-directed Tier 2 audit, not a proof that every repository issue
has been found. Historical experiment evidence and the pre-existing changes
in four capture/export scripts are preserved.

## Findings and changes

| Priority | Finding | Result |
| --- | --- | --- |
| High | API imports nonexistent `simulator/src/report/metrics` | Reuse and export the existing `operationalStats`; server and API tests now run |
| High | CI only verifies/publishes simulator | Shared checks now cover simulator, API, frontend, Locust, and all Kustomizations; release publishes four SHA-tagged images |
| Medium | Simulator tests run on host and again in image build | Tests are an explicit publication gate; runtime builds install dependencies without repeating tests |
| Medium | No persistent Docker build cache | Buildx uses per-image GitHub Actions caches; npm and Locust dependency downloads are cached |
| Medium | Root-context API build can send large historical artifacts | Root `.dockerignore` permits only required simulator/API sources and manifests |
| High | Local image tags/default storage do not describe an AKS deployment | Separate Azure reference overlays use ACR images, explicit CSI classes, and an isolated namespace |
| High | RWO does not enforce a single writer; API archive readers need cross-node access | Runner uses Azure Disk RWOP; completed archive uses Azure Files RWX and read-only API mounts |
| Medium | API readiness always succeeds even if storage is inaccessible | Readiness checks the mounted directory; liveness remains independent; shutdown drains HTTP requests |
| Medium | Archive and report use different header/brand/control layouts; loading views lose navigation | Shared header, responsive labels, consistent controls, spacing, skip navigation, and reduced-motion support |
| Medium | Static assets served without compression or differentiated caching | Nginx compresses supported text types, caches hashed assets, and revalidates the HTML entry point |

PR CI runs without path filters so a required check is not left pending on
documentation-only changes. This prioritizes reliable checks over minimum
runner minutes. If cost becomes material, add path-aware conditional jobs with
an always-running aggregate gate; include shared simulator report-code changes
in the API dependency set.

## Remaining performance decisions

The runner opens, writes, flushes, and closes each accepted JSONL result.
Checkpoint writes serialize JSON, flush a temporary file, then rename it.
This is a real serialized durability cost. Existing different-seed runs at
concurrency 10 and 15 do not isolate storage latency, so they do not establish a
controlled concurrency optimum. Benchmark identical seeds/images/resources on
Azure Disk before changing checkpoint frequency or introducing batch commits.
Any future batching needs restart/duplicate/interruption tests that preserve
the accepted-result contract.

The API intentionally caches one full run and serializes heavyweight loads.
Switching between large runs can repeatedly parse and validate roughly 52 MB
of JSONL per committed full run. Raising the cache count trades latency for
heap growth. A next design could persist validated lightweight summaries and
indexed result projections alongside immutable exports; it must preserve strict
validation and source signatures. The initial Azure API memory settings are a
starting point to measure, not a proven right-sizing result.

Offline reports are currently read into a complete Buffer before sending.
Concurrent large downloads add to API memory use. If downloads become a real
traffic pattern, stream validated report files with backpressure and test
disconnects, file replacement, error handling, and content-length behavior.

## Deployment boundary

The prepared manifests remain reference templates until registry and commit
placeholders are resolved. `scripts/prepare-azure.py` creates reviewable copies
without changing the local lab or contacting a cloud service. The runner,
load generator, import/export tools, and gateway are separate opt-in overlays.
The initial explorer is reachable through port-forwarding. Completed exports
are promoted into its archive; live state is never used as an API write target.

There is no automatic Azure deployment, subscription provisioning, or invented
application-secret dependency. The existing Argo CD dev/prod overlays retain
their local-lab role. Choose an Azure deployment owner after learning manual
promotion and rollback.

## Evidence and limits

The graph was indexed specifically for this worktree as
`autoscaling-final-lab-d088`, initial generation `2026-10-03T08:20:32Z`.
Relevant symbol searches and both-direction traces were used for the explorer
cache, report shell, and persistence primitives. Exact snippets were checked;
coverage checks reported metadata changes and partial parsing for Dockerfiles
and Nginx. Those configurations and the relevant source were read directly.
Dynamic injected persistence calls are not fully represented by static call
edges; source and the interruption tests provide additional evidence.

Validation: 339 Linux simulator/API tests passed on Node 24.20.0; 9 frontend
tests passed and TypeScript/Vite built on Node 24.19.0; 5 Locust tests passed;
22 Kustomizations rendered and Azure boundary checks passed. Existing Windows
server tests assume POSIX path separators and privileged file symlinks, so the
Linux run is the relevant deployment result. A Windows portability cleanup is
separate from this Azure migration.

Headless Edge checks exercised the real archive/API, opened a sample report,
and checked 320px/375px report layouts and sticky navigation without page
overflow or browser exceptions. Desktop and mobile screenshots were reviewed.
Prepared release copies also rendered with an all-numeric SHA tag and matching
runner image provenance; tags are quoted to preserve their YAML string type.
Both GitHub workflows passed actionlint 1.7.12 validation.

Docker Desktop's Linux daemon was unavailable during this audit. No images
were built locally and no AKS server-side dry run, disk restart experiment,
load test, or cloud rollout was performed. CI builds and Azure runtime checks
remain required before declaring a particular release deployed successfully.
