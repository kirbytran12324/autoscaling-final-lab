# Tournament controls: application and platform handoff

The application supports authenticated creation, progress/log monitoring,
pause/resume, and validated archive publication. The existing explorer API stays
GET-only and archive-only. Application deployment does not start a tournament.

For AWS managed login, required configuration, the proxy trust boundary, logout,
and the later Terraform handoff, see [Operator authentication](control-authentication.md).
The bearer instructions below describe the separately selected local mode.

## Components and boundaries

- `control-api/`: Node 24 service, port 3002. Calls Kubernetes with its projected
  ServiceAccount token and cluster CA; reads token rotation on every request.
  Does not mount either PVC, run shell commands, or invoke kubectl.
- The simulator image includes the runner and `src/publish-cli.js`. Generated
  Jobs run Node directly, with parallelism/completions one. Concurrency means
  simultaneous battle requests from that single runner, not multiple runners.
- Runner status: private `/status` on port 3003, authenticated with a separate
  token. Reads the runner's own state and returns up to 100 recent events.
  Standings follow existing persistence cadence: 10 sample results / 1,000 full
  results. Brackets update at round boundaries; these are provisional snapshots.
- Browser `/operate` and `/operate/runs/:id`: controls enabled by runtime
  configuration. Entering from the public archive uses full browser navigation.
  In bearer mode the operator token stays in memory; reloading, leaving the page,
  or locking requires unlocking again. ALB mode uses the managed browser session.
  Status and bounded recent logs refresh every three seconds.

## API contract

In `CONTROL_AUTH_MODE=bearer`, all `/api/control/*` requests require
`Authorization: Bearer <operator-token>`.
Tokens never belong in runtime configuration, JavaScript, URLs, or browser
storage. Cross-origin requests are rejected. `CONTROL_AUTH_MODE=alb` instead
uses verified ALB identity and explicit CSRF protection, with no bearer fallback.
POST requests are limited to 20/minute/connection address, and JSON bodies to
4 KiB. Health endpoints expose only live/ready status without authentication.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/control/session` | Minimal authorized identity, mode and maximum concurrency |
| `GET /api/control/options` | Configured maximum concurrency |
| `GET /api/control/runs` | Managed history |
| `POST /api/control/runs` | Reserve and create tournament |
| `GET /api/control/runs/:id` | Phase and live snapshot |
| `GET /api/control/runs/:id/logs` | Recent runner/publisher logs |
| `POST /api/control/runs/:id/pause` | Suspend Job |
| `POST /api/control/runs/:id/resume` | Resume with frozen identity |
| `POST /api/control/runs/:id/retry-publication` | Retry archive publication |
| `POST /api/control/runs/:id/release-failed` | Release failed runner; keep evidence |

```json
{"runId":"sample-demo-001","mode":"sample","seed":"demo-seed","concurrency":2}
```

IDs contain lowercase letters/digits/hyphens, start/end with a letter or digit,
and have at most 40 characters. Mode is sample/full. Seed is 1–128 characters,
without control characters or surrounding whitespace. Concurrency is an integer
from one to the configured limit. Unknown fields are rejected. Image, commands,
namespace, versions, PVCs, simulator address, and security come from server
configuration. Same-ID/same-settings requests return existing status; different
settings return `RUN_ID_CONFLICT`. A different run while reserved returns
`RUNNER_BUSY`. After an uncertain transport error, resubmit the same ID/settings.

## Persistence and reconciliation

Atomic creation of ConfigMap `metronome-runner-slot` admits one run. Its request
and frozen deployment values recover a crash before the per-run registry exists.
ConfigMap `mt-run-<id>` keeps the run record and desired pause state. These have
no owner reference to the API Pod. A restart resumes reconciliation. Keep these
records and the slot; deleting them manually bypasses admission/history.

Kubernetes lists use bounded pages and opaque continuation tokens internally;
the public managed-history response remains unchanged. Each transport response
is capped at 4 MiB. Oversized pages restart the listing with smaller page sizes
down to one item, discarding partial snapshots. UTF-8 request bodies, persisted
identities and logs are decoded across complete byte sequences. No registry
records or completed archives are deleted by pagination; aggregate history
memory still grows with retained records, so a future retention policy must
remain separate from immutable archive retention.

Runner Job `mt-runner-<id>-1` starts suspended, then reconciliation applies its
desired state. Generated Pods run non-root, drop capabilities, use a read-only
root filesystem, and disable ServiceAccount automounting. Seed, versions, image,
and concurrency remain frozen across replacement and resume.

The active PVC **must use ReadWriteOncePod with a compatible CSI driver**.
The reservation admits one logical run; RWOP fences overlapping Pod attachment.
ReadWriteOnce alone can allow multiple writers on one node. Do not run legacy
static Jobs concurrently or force-delete/detach an unreachable writer.

Pause terminates active Pods. SIGTERM stops new scheduling and drains in-flight
requests and accepted-result writes. The 180-second grace period exceeds the
normal four 30-second request attempts and retry delays. A replacement resumes
from accepted results and the immutable identity. Genuine request failures
while draining still fail the tournament. Forced kills during writes can leave
malformed evidence, which recovery rejects rather than silently repairing.

After runner success, the API saves recent logs, foreground-deletes the Job,
waits for its Pods to disappear, then starts `mt-publish-<id>-<attempt>`. Publisher
mounts state read-only and archive read-write. It validates canonical completion
and unique results, stages copies outside `runs`, verifies SHA-256 fingerprints,
generates a report, and renames the staged directory into `runs`. Staging and
destination must be on one filesystem. Existing archives must validate and match
canonical fingerprints; conflicts fail closed. Other archive writers must obey
the same contract. Real Azure Files rename behavior needs platform validation.

Publisher success reports archive ready; the slot releases after publisher
Pods are removed. The explorer validates independently before serving. Failed
publication retains the slot and can retry without rerunning battles. The first
retry may return `PUBLICATION_DRAINING`; retry after old Pods terminate.

Runner Job failure holds the slot for inspection. `release-failed` removes its
Job/Pods and releases the slot while preserving registry/disk evidence. It does
not repair failed metadata. A terminally failed tournament needs a new ID.
Infrastructure failures with running metadata use the bounded Job retry policy;
additional recovery after exhaustion remains an operator procedure.

## Kubernetes resources for your lab

Write and review these resources in order; none are provisioned by these app changes:

1. Dedicated ServiceAccount, namespace-scoped Role and RoleBinding.
2. Secret with `runner-status-token` (at least 32 characters). Local bearer mode
   also requires a distinct `operator-token` of at least 32 characters. AWS ALB
   mode does not use an operator token. Provision values outside Git and evidence.
3. Active RWOP and archive RWX claims with independent lifecycles. Azure Disk
   and Azure Files respectively; keep completed explorer mounts read-only.
4. Control Deployment (one replica initially) and ClusterIP Service named
   `metronome-control-api`, port 3002. API needs its projected ServiceAccount
   token; generated Job Pods do not. Non-root UID 1000 and read-only root work
   without a data mount. Liveness `/health/live`, readiness `/health/ready`.
5. Private ClusterIP Service `metronome-runner-status`, port 3003, selecting
   `app.kubernetes.io/managed-by=metronome-control` and `metronome.kind=runner`.
   Exclude publishers and restrict network access to the control API.
6. Frontend ConfigMap mounting `explorer-web/control-proxy.conf` read-only at
   `/etc/nginx/control.d/control.conf`. Control Service must exist before web
   startup because Nginx resolves its upstream name at startup.
   Preserve the incoming `Host` header, including its port, with `$http_host`.
   Using `$host` drops a local port-forward port and causes the API's origin
   check to reject otherwise valid browser control requests.
7. Add `controlEnabled: true` to the existing web runtime ConfigMap, preserving
   the pinned asset URL. Restart the web Deployment after ConfigMap changes.
8. Later add Gateway/HTTPS routing to web. Keep both control/status Services
   internal; use TLS before transmitting operator credentials over the Internet.

| API group | Resource | Required verbs |
| --- | --- | --- |
| core | `configmaps` | `get`, `list`, `create`, `update`, `delete` |
| batch | `jobs` | `get`, `create`, `patch`, `delete` |
| core | `pods` | `list` |
| core | `pods/log` | `get` |

No Secret-read, Pod-exec, Deployment-write, PVC-delete, or cluster role is needed.
Namespace RBAC cannot limit Job creation by labels/templates: creation is a
powerful permission, including the ability to mount Secrets. Use a dedicated
lab namespace, restricted Pod admission and network boundaries. Labels select
objects but do not authorize them.

| Control Deployment variable | Value/source |
| --- | --- |
| `CONTROL_AUTH_MODE` | Required: `bearer` locally, `alb` behind AWS ALB |
| `CONTROL_NAMESPACE` | Application namespace |
| `CONTROL_OPERATOR_TOKEN` | Secret `operator-token`; required only in bearer mode |
| `RUNNER_STATUS_TOKEN` | Secret `runner-status-token` |
| `RUNNER_STATUS_SECRET` | Name of that Secret |
| `RUNNER_IMAGE` | Tested runner/simulator image; use digest for releases |
| `RUNNER_STATE_CLAIM` / `ARCHIVE_CLAIM` | Active / archive PVC names |
| `SIMULATOR_BASE_URL` | `http://metronome-simulator` |
| `RULES_VERSION` | `metronome-singles-v1` |
| `SIMULATOR_VERSION` | `pokemon-showdown@0.11.11` |
| `RUNNER_STATUS_URL` | `http://metronome-runner-status:3003` |
| `RUNNER_STATUS_PORT` | Optional; default 3003 |
| `CONTROL_MAX_CONCURRENCY` | Optional; default 16, maximum 64 |
| `PORT` / `HOST` | Optional; default 3002 / `0.0.0.0` |

## Build, validation, and first exercise

```powershell
node --test control-api/test/*.test.js
npm --prefix explorer-web test
npm --prefix explorer-web run build
$env:CONTROL_CHECK_BROWSER = 'msedge'
npm --prefix explorer-web run check:controls
docker build -t metronome-control-api:local control-api
docker build -t metronome-runner:local simulator
docker build -t metronome-explorer-web:local explorer-web
```

Run the full simulator suite in Linux: existing path assertions require Linux
separators. Application tests cover simultaneous admission, API restart, graceful
group/knockout stop and deterministic recovery, authentication, and publication.
Delivery workflows include control tests and all five application/tool images.
Each image is built once, loaded locally, checked, and only then published when
the reusable workflow receives `publish: true`. Browser controls also run with
isolated Kubernetes fixtures. These workflow changes do not deploy the app.

First cluster exercise: create a new sample run at concurrency two, reject an
unauthenticated request and a second tournament, pause after accepted battles,
resume, replace the API Pod, finish, and inspect the completed archive. Also test
denied RBAC, missing runner Secret, simulator failure and publisher failure/retry.
Verify accepted results and persistent data after replacement.

Logs/events are bounded and may disappear during Pod replacement; use Container
Insights for durable history. Paused runs retain a progress count; live snapshots
return after resume. Shared operator authentication has no per-user attribution.
Registry retention and crash-left staging-directory cleanup need explicit
maintenance. Tests do not prove real CSI fencing, RBAC, Gateway/TLS, NetworkPolicy,
Azure Files semantics or rollout behavior: those are cluster acceptance gates.

## Application verification: October 9, 2026

- Complete simulator suite: 333 tests passed against the final Linux runner image.
- Control API image suite: 13 checks passed, including production-server health,
  atomic admission, restart recovery, slot deletion fencing and publisher handoff.
- Frontend: 24 tests passed; TypeScript and production build passed.
- Production-build browser fixture: authentication, creation, progress,
  pause/resume, publication, desktop/mobile layout and zero page errors passed.
- All three changed application images built locally. Web image started with
  a read-only filesystem and temporary `/tmp`; health, runtime config and
  `/operate` returned successfully. Optional Nginx control proxy validated.
- Existing frontend development dependencies have two npm advisories: low in
  `@babel/core`, high in `source-map-js`. Their pinned versions were unchanged
  by this implementation; resolve these separately before the release audit.
- No Kubernetes/Azure resources were changed, and no images were published.

## Local verification: October 10, 2026

- Newly built Node 24.20.0 Linux images passed 333 simulator/runner/publisher
  tests, 32 explorer API tests, and 13 control API checks. Frontend tests passed
  all 24 cases in Linux; TypeScript and the production build passed.
- Headless Edge exercised the production frontend with simulated Kubernetes:
  authentication, creation, progress, pause/resume, publication and desktop/mobile
  layouts passed without page errors. This does not prove real Job execution.
- Actual Nginx forwarding reproduced a same-origin request returning 403 when
  the browser URL included a port. After preserving `$http_host`, the same
  authenticated creation request returned 202; unauthenticated and foreign-origin
  requests still returned 401 and 403. The backend used simulated Kubernetes.
- Simulator and explorer production images passed readiness checks. The web
  image served health, `/operate`, runtime configuration and real explorer run
  discovery through Nginx with a read-only filesystem and temporary `/tmp`.
- Docker Desktop's `autoscaling-lab` namespace has no control Deployment or
  Service. Controls are disabled in the current web runtime configuration.
  No CSI drivers are registered; both storage classes use `rancher.io/local-path`.
  The required RWOP state-volume fencing and real runner/publisher handoff have
  not been verified in this cluster.
- At initial inspection, the release workflow configured four images and omitted
  `control-api/**` from its push path filter. CI then omitted control API tests
  and its image. Neither
  workflow deploys the application. Existing Argo CD overlays track the simulator
  with fixed local image tags; publishing a new GHCR image does not update them.
- No cluster resources, credentials or persistent data were changed. Temporary
  verification containers and networks were removed; no images were published.

## CI follow-up: October 10, 2026

The guided CI changes now include the control API test/image matrices and its
release path filter. Image build steps load into Docker without publishing;
the separate publication step runs only after that matrix entry's checks pass.

| Image | Check against the packaged runtime |
| --- | --- |
| Control API | Node tests with read-only test mount |
| Simulator / runner / publisher | Node tests with read-only helpers and evidence |
| Explorer API | Node tests with read-only completed evidence |
| Web | Nginx startup, built JS/CSS, player files, runtime caching and control proxy |
| Load generator | Python unit tests with fake responses and networking disabled |

The web check runs through `scripts/check-web-image.mjs`. It verifies startup
without a control Service, then mounts the optional proxy and checks missing
authentication (401), a foreign origin (403), and authenticated creation with a
port in the origin (202). The backend uses simulated Kubernetes; no Jobs start.
Temporary containers and a private Docker network are cleaned up on success or
failure. `node scripts/check-web-image.mjs <web-image>` also runs on Windows.

The frontend source job builds, installs Chromium through Playwright and runs
`check:controls`. Browser-launch failures now close the fixture server instead
of leaving the process running. The operations job validates workflows with
actionlint 1.7.12. The release filter includes changes to the new web check.

Local validation of this follow-up passed: 32 packaged explorer API tests,
7 packaged load-generator tests, web image/proxy checks, the Edge controls
fixture and actionlint. The web production build passed in Linux. Actual
GitHub runner execution, Linux Chromium execution, registry publication and
real Kubernetes Job execution remain unverified by this local check.

Publication is independent per image. A failed image check prevents its own
publication; other matrix entries may still publish. Each successful publishing
job captures its repository digest and source commit in a separate artifact.
The `release-ready` job waits for all five image jobs, downloads records from the
current run attempt, validates their names, commits, repositories and digest
format, then saves one `release.json` artifact. Records expire after 30 days.
Use "Re-run all jobs" when retrying publication; rerunning only failed jobs
does not produce all five records for the new attempt.

Local checks accepted a complete matching release and rejected missing,
duplicate, extra, mismatched-commit, wrong-repository and malformed-digest
records. Digest selection rejected missing, wrong-repository and ambiguous
references. Actual GHCR digest capture and GitHub artifact transfer remain
unverified. These checks establish release consistency, not independent proof
of build provenance. Controlled deployment promotion remains a later step.
Keep current PVCs and completed data outside application rollback and automatic
pruning; no deployment or credential changes are part of this CI follow-up.
