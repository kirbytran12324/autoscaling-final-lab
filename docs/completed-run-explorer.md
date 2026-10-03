# Completed-run explorer

Status: local completed-run explorer with verified, in-page battle replays.

The completed-run explorer provides a browser interface over canonical tournament artifacts. It does not start, resume, cancel, or modify tournaments, and it does not query Kubernetes. Replay requests regenerate battles through the internal simulator and verify them against completed tournament evidence before displaying the local Showdown player.

## Architecture and trust boundaries

```text
Browser
  │ HTTP (local port-forward now; Gateway API later)
  ▼
metronome-explorer-web Deployment + ClusterIP Service
  ├─ Nginx serves the compiled React application
  ├─ /api/* is proxied to metronome-explorer-api:3001
  ├─ no PVC, ServiceAccount token, Kubernetes API permission, or cloud credential
  ▼
metronome-explorer-api Deployment + ClusterIP Service
  ├─ read-only endpoints only
  ├─ FilesystemArtifactStore boundary
  ├─ existing strict loadTournamentArtifacts validation
  └─ tournament-state PVC mounted read-only
       └─ runs/<runId>/{canonical artifacts, report.html}
```

The filesystem store is the only component that knows how artifacts are stored. A future Blob-backed store can implement the same API-facing operations without changing the browser contract. `report.html` is served only as an existing download; it is never parsed as data. Run discovery excludes missing, incomplete, malformed, identity-conflicting, or otherwise invalid runs by applying the same strict validation used by the offline report.

The API keeps at most one validated run in an in-memory cache and invalidates it when artifact size or modification timestamps change. The cache is ephemeral and is not a database or source of truth.

## Repository layout

| Path | Purpose |
| --- | --- |
| `explorer-api/src/artifact-store.js` | Filesystem store, path safety, strict completed-run loading, bounded filters/pagination, and report download |
| `explorer-api/src/report-projection.js` | Renderer-aligned integrity, operational-statistics, and Pod-attribution projection |
| `explorer-api/src/app.js` | Read-only HTTP routing and structured public errors |
| `explorer-api/test/` | Temporary-directory fixture tests using a copied committed completed run |
| `explorer-web/src/` | React/TypeScript dashboard and offline-report-parity tournament view |
| `explorer-web/nginx.conf` | Static serving and same-origin `/api` proxy |
| `k8s/explorer/` | Additive Deployments and ClusterIP Services only |

## API

The initial surface is:

- `GET /api/runs`
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/standings?group=&q=&cursor=&limit=`
- `GET /api/runs/:runId/bracket`
- `GET /api/runs/:runId/matches?cursor=&limit=&q=&stage=&result=&hostname=&sort=&direction=`
- `GET /api/runs/:runId/matches/:matchId`
- `GET /api/runs/:runId/matches/:matchId/replay`
- `GET /api/runs/:runId/report`

Standing and match cursors are opaque and bound to every active query option. The default page size is 25 and the maximum is 100. Match filters accept the bounded stage values `Group stage` and `Knockout`, result values `win` and `tie`, exact hostnames exposed by the run projection, sortable report columns, and `asc` or `desc` direction. Unknown parameters and invalid enum values are rejected. Errors use this shape and never include filesystem paths:

```json
{
  "error": {
    "code": "RUN_NOT_FOUND",
    "message": "Tournament run was not found."
  }
}
```

The API rejects non-DNS-style run IDs, malformed match IDs, unsafe symlinked run directories or artifact files, invalid cursors, oversized pages, and every non-GET API request.

## Run locally with a completed fixture

Node.js 24 is required. The committed tournament evidence is already arranged as a state root containing `runs/`, so it can be used as a read-only local fixture.

Install the existing shared validator dependency once:

```sh
cd simulator
npm ci --omit=dev --ignore-scripts
cd ..
```

Terminal 1 (simulator):

```sh
cd simulator
npm start
```

Terminal 2 (API):

```sh
cd explorer-api
TOURNAMENT_STATE_ROOT="$PWD/../evidence/tournaments" SIMULATOR_BASE_URL=http://127.0.0.1:3000 npm start
```

Terminal 3 (frontend):

```sh
cd explorer-web
npm ci --ignore-scripts
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` to `http://127.0.0.1:3001`. To use another API address, set `VITE_API_TARGET` before starting Vite.

Useful checks:

```sh
curl http://127.0.0.1:3001/api/runs
curl 'http://127.0.0.1:3001/api/runs/sample-32-002/matches?limit=5&q=kyogre&stage=Knockout&sort=turns&direction=desc'
```

## Test and build

```sh
cd explorer-api
npm test

cd ../explorer-web
npm ci --ignore-scripts
npm test
npm run build

cd ..
docker build -f explorer-api/Dockerfile -t metronome-explorer-api:0.1.0 .
docker build -t metronome-explorer-web:0.1.0 explorer-web
```

The API image uses the repository root as its build context because it reuses the simulator's strict artifact validator. The web image uses only `explorer-web/` as its context.

The detailed offline-to-online section, interaction, and evidence mapping is recorded in the [completed-run parity checklist](completed-run-explorer-parity.md).

## Deploy only the additive local resources

Prerequisites:

- the `autoscaling-lab` namespace already exists;
- the existing `tournament-state` PVC already exists in that namespace; and
- the two image tags above are available to the local cluster.

Render and apply only this milestone:

```sh
kubectl kustomize k8s/explorer
kubectl apply -k k8s/explorer
kubectl -n autoscaling-lab rollout status deployment/metronome-explorer-api
kubectl -n autoscaling-lab rollout status deployment/metronome-explorer-web
kubectl -n autoscaling-lab port-forward service/metronome-explorer-web 8080:80
```

Open `http://127.0.0.1:8080`. No accepted baseline kustomization references `k8s/explorer`; applying it is an explicit, independent operation. Both Services are `ClusterIP`. The frontend mounts only an ephemeral `/tmp`, while the API mounts `tournament-state` read-only. Both Pods disable ServiceAccount token automounting.

Delete only the additive workloads with:

```sh
kubectl delete -k k8s/explorer
```

This does not delete the namespace, PVC, simulator, runner Jobs, HPA, VPA, or Locust resources.

## Verified replays

Select a recorded match and choose **Watch replay**. The in-page dialog regenerates and verifies the battle, then opens the player paused and muted. See the [verified replay guide](battle-replays.md) for controls, limits, browser checks, and deployment configuration. The API uses `SIMULATOR_BASE_URL=http://metronome-simulator` in the local Kubernetes explorer. The simulator must already be running in the namespace.

## Deferred concerns

- **Live progress:** requires an explicit incomplete-run projection and must not weaken the strict completed-run validator.
- **Run control:** start, resume, cancel, and authorization are separate control-plane work; no related endpoint exists here.
- **Azure Blob Storage:** implement a Blob artifact store behind the current boundary, including consistency, pagination, cache invalidation, and managed identity. No Azure manifest or credential is introduced here.
- **Gateway and authentication:** routing and identity policy belong to a later deployment milestone; this local milestone uses port-forwarding and ClusterIP Services only.
