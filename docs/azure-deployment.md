# Azure deployment reference

Use this after the corresponding checkpoint in the [learning plan](azure-learning-plan.md).
These are reference instructions, not an instruction to run every step at once.
The repository changes do not create cloud resources. Commands below use
PowerShell from the repository root; Azure CLI, Docker, kubectl, Git, Python,
and Node 24 are prerequisites. Use WSL/Bash for the existing evidence scripts.

## What changes when leaving the local cluster

| Local assumption | Azure replacement | Reference |
| --- | --- | --- |
| Docker Desktop supplies images to workers | ACR images accessible through the kubelet managed identity | Image entries in each Azure overlay |
| Default local filesystem StorageClass | Explicit Azure Disk for live state; Azure Files for completed exports | `azure/runner/state.yaml`, `azure/app/archive.yaml` |
| RWO plus operational singleton discipline | RWOP disk plus one Job and replacement only after failure | `azure/runner` |
| Locust targets `autoscaling-lab` DNS | Locust and simulator share `metronome-azure` namespace | `azure/load-test` |
| Local Metrics Server TLS workaround | AKS-managed metrics service | No addon installation in Azure overlays |
| Local node capacity is fixed | VM pool capacity, optionally cluster autoscaler | Configure AKS separately |
| Workstation access by port-forward | Keep port-forward initially; optional Gateway API later | `azure/gateway` |
| Argo CD owns local dev/prod environments | Manual Azure promotion first; choose one owner later | Existing local GitOps files remain separate |

`k8s/azure/app` deploys simulator + HPA + explorer API/web + archive PVC.
It creates no runner, load test, or external endpoint. `runner`, `load-test`,
`import`, `export`, and `gateway` are independent, opt-in overlays that assume
the app namespace exists.

## Account and resource group

Install the Azure CLI yourself, sign in, select your subscription, and inspect
the selected account. Choose a region and globally unique lowercase ACR name.
Create a budget alert before paid resources. A budget alert does not cap spend.

```powershell
az login
az account list -o table
az account set --subscription '<your-subscription-id>'
az account show -o table

$labRegion = 'southeastasia'
$labGroup = 'rg-metronome-learning'
$labCluster = 'aks-metronome-learning'
$labRegistry = '<your-unique-acr-name>'
az aks get-versions --location $labRegion -o table
az group create --name $labGroup --location $labRegion
az acr create --resource-group $labGroup --name $labRegistry --sku Basic --admin-enabled false
$labLoginServer = az acr show --name $labRegistry --query loginServer -o tsv
```

The starting instructions use a registry with ordinary RBAC permissions.
If choosing ACR's ABAC repository-permission mode, follow its supported role
assignment workflow rather than assuming `--attach-acr` is sufficient.

## Build and deliver one committed revision

Commit the revision you intend to deploy and run tests first. SHA tags identify
code; never reuse that tag for different uncommitted content. Start Docker's
Linux engine before building. The API build context is the repository root.

```powershell
$labRevision = git rev-parse HEAD
az acr login --name $labRegistry
docker build -t "${labLoginServer}/metronome-simulator:${labRevision}" simulator
docker build -f explorer-api/Dockerfile -t "${labLoginServer}/metronome-explorer-api:${labRevision}" .
docker build -t "${labLoginServer}/metronome-explorer-web:${labRevision}" explorer-web
docker build -t "${labLoginServer}/metronome-load-test:${labRevision}" load-test
foreach ($component in @('simulator','explorer-api','explorer-web','load-test')) {
  docker push "${labLoginServer}/metronome-${component}:${labRevision}"
  if ($LASTEXITCODE -ne 0) { throw "Image push failed: $component" }
}
```

After the CI lesson, the main-branch release also publishes these four images
to GHCR with the full commit SHA. Public GHCR images can be imported to ACR;
private sources need their documented authentication flow. Keep the deployed
image and runner's `SIMULATOR_IMAGE` provenance identical. The runner overlay
derives that environment value from the rendered image automatically.

## Create the small AKS cluster

Use a supported regional Kubernetes version and Linux workers. The example
uses two four-vCPU workers so shared system workloads, explorer memory, and
simulator replicas have room; it is a learning baseline, not a cost-optimized
production recommendation. Check quota and pricing for the selected region
and SKU before running it.

```powershell
az aks create --resource-group $labGroup --name $labCluster --tier free --node-count 2 --node-vm-size Standard_D4s_v5 --enable-managed-identity --attach-acr $labRegistry --network-plugin azure --network-plugin-mode overlay --generate-ssh-keys
az aks get-credentials --resource-group $labGroup --name $labCluster
kubectl config current-context
kubectl get nodes -o wide
kubectl get storageclass
kubectl top nodes
```

Creating AKS with ACR integration requires permission to assign its pull role.
Inspect the managed node resource group and identities in the portal. The
overlay expects `managed-csi-premium` and `azurefile-csi`. AKS already provides
Metrics Server and CSI drivers; do not apply the local insecure Metrics Server
addon. VPA is not required for the first cloud deployment.

## Prepare, render, then deploy

First inspect the checked-in reference overlays yourself. They contain obvious
registry and revision placeholders. The helper prepares a new copy of the
manifest tree so a release can be reviewed without changing local-lab files.
Use a fresh output directory for each preparation; it refuses overwrites.

```powershell
$labReleaseDirectory = ".validation/azure-$labRevision"
python scripts/prepare-azure.py --registry $labLoginServer --image-tag $labRevision --output $labReleaseDirectory
$labAzureDirectory = "$labReleaseDirectory/k8s/azure"
kubectl kustomize "$labAzureDirectory/app"
kubectl apply --dry-run=server -k "$labAzureDirectory/app"
kubectl diff -k "$labAzureDirectory/app"
# kubectl diff returns 1 when it finds expected differences.
kubectl apply -k "$labAzureDirectory/app"
kubectl -n metronome-azure rollout status deployment/metronome-simulator --timeout=300s
kubectl -n metronome-azure rollout status deployment/metronome-explorer-api --timeout=300s
kubectl -n metronome-azure rollout status deployment/metronome-explorer-web --timeout=300s
kubectl -n metronome-azure get pods,svc,hpa,pvc
kubectl -n metronome-azure port-forward service/metronome-explorer-web 8080:80
```

Namespace creation may need to precede an initial server-side dry run because
the namespace does not yet exist. Render/review the Namespace, apply it alone,
then repeat the dry run. Visit `http://127.0.0.1:8080`. An empty archive is a
valid first result. The web proxy sends `/api/` to the API inside the same
namespace; API and simulator Services remain ClusterIP.

The API runs with a 2Gi memory ceiling because full-run validation loads large
canonical artifacts. Measure cold and warm requests before lowering it. One
replica is the initial baseline; the RWX archive permits readers on different
nodes when you later scale it. The runner remains a singleton.

## Import a committed sample export

Use the small sample first. The temporary import Pod is the only tool with
write access to the completed archive. Stage outside `runs`, validate canonical
artifacts, and rename within the share so discovery does not see a partial copy.
The API's strict validation remains authoritative.

```powershell
kubectl apply -k "$labAzureDirectory/import"
kubectl -n metronome-azure wait --for=condition=Ready pod/archive-import --timeout=300s
kubectl -n metronome-azure exec archive-import -- mkdir -p /archive/staging/runs /archive/runs
kubectl -n metronome-azure cp evidence/tournaments/runs/sample-32-002 archive-import:/archive/staging/runs/sample-32-002
kubectl -n metronome-azure exec archive-import -- env TOURNAMENT_STATE_ROOT=/archive/staging TOURNAMENT_RUN_ID=sample-32-002 node src/report-cli.js
kubectl -n metronome-azure exec archive-import -- node -e 'const fs=require("node:fs"); const source="/archive/staging/runs/sample-32-002"; const destination="/archive/runs/sample-32-002"; if(fs.existsSync(destination)) throw new Error("Export already exists"); fs.renameSync(source,destination);'
kubectl -n metronome-azure delete pod archive-import
```

Use a new run ID for future exports; never overwrite canonical completed runs.
Inspect archive events and permissions if import fails. The Azure Files CSI
driver provisions its share and platform storage authentication; this is
separate from any application credential. The application has no reason to
invent a Key Vault secret for this lesson.

## Run, export, and validate a cloud tournament

The reference runner starts a new `azure-sample-001` identity at concurrency 2.
Do not start a second writer. Resume requires the exact same run identity,
seed, image, and concurrency. Choose a new ID/seed deliberately for a new run.

```powershell
kubectl kustomize "$labAzureDirectory/runner"
kubectl apply --dry-run=server -k "$labAzureDirectory/runner"
kubectl apply -k "$labAzureDirectory/runner"
kubectl -n metronome-azure logs -f job/tournament-runner
kubectl -n metronome-azure wait --for=condition=Complete job/tournament-runner --timeout=1800s
```

After confirming completion, save logs and inspect `run-metadata.json` in the
subsequent export. Delete only the completed Job so its Pods release the RWOP
mount, then attach the read-only export Pod. Keep the PVC.

```powershell
kubectl -n metronome-azure delete job tournament-runner --wait=true
kubectl apply -k "$labAzureDirectory/export"
kubectl -n metronome-azure wait --for=condition=Ready pod/state-export --timeout=300s
New-Item -ItemType Directory -Path .validation/cloud-export/runs -Force
kubectl -n metronome-azure cp state-export:/state/runs/azure-sample-001 .validation/cloud-export/runs/azure-sample-001
kubectl -n metronome-azure delete pod state-export
$env:TOURNAMENT_STATE_ROOT = (Resolve-Path .validation/cloud-export).Path
$env:TOURNAMENT_RUN_ID = 'azure-sample-001'
node simulator/src/report-cli.js
```

The report command validates canonical completion before producing derived
HTML. Import the validated directory using the same staging/rename sequence
above, substituting `azure-sample-001`. Keep provenance and checksum records
with any evidence you retain. Do not run the Linux evidence scripts directly
in PowerShell; use their documented Bash/WSL environment and explicitly target
`metronome-azure` when adapting their namespace configuration.

## Autoscaling lesson

Deploy the opt-in load generator, port-forward its internal Service, and run
a small finite test. Observe `kubectl get hpa -w`, `kubectl top pods`, and Pod
events while Locust starts and stops. Do not expose Locust on a public gateway.

```powershell
kubectl apply -k "$labAzureDirectory/load-test"
kubectl -n metronome-azure port-forward service/metronome-load-test 8089:8089
```

When ready to study node scaling, separately enable a bounded cluster autoscaler:

```powershell
az aks update --resource-group $labGroup --name $labCluster --enable-cluster-autoscaler --min-count 2 --max-count 3
```

Node scaling is triggered by scheduling needs. Recalculate the capacity-demo
requests for these workers rather than applying the local demo unchanged.
Retain identical seeds/images/resources for controlled throughput comparisons.

## Optional gateway lesson

Use this only after the port-forwarded deployment works. The reference is an
HTTP learning example with `explorer.example.com`; edit the hostname before
rendering. Complete DNS/TLS configuration using the current Azure guide before
publishing it as a public service. This adds managed gateway replicas and a
load balancer; it is not part of the initial lab deployment.

```powershell
az aks update --resource-group $labGroup --name $labCluster --enable-gateway-api --enable-app-routing-istio
kubectl get gatewayclass
kubectl apply --dry-run=server -k "$labAzureDirectory/gateway"
kubectl apply -k "$labAzureDirectory/gateway"
kubectl -n metronome-azure get gateway,httproute
```

The reference uses the [AKS Gateway API application routing implementation](https://learn.microsoft.com/en-us/azure/aks/app-routing-gateway-api), whose current setup requires Azure CLI 2.86 or newer. Verify prerequisites and regional availability when you reach this lesson.

## Release and cleanup checks

Deploy a previous prepared revision to practice rollback. Render/diff it first;
the HPA owns simulator replicas, while runner Jobs require deliberate immutable
run identity management. Verify image references, events, readiness, `/api/runs`,
sample details, and the offline download after each deployment.

Between sessions, inspect costs and use [AKS stop/start](https://learn.microsoft.com/en-us/azure/aks/start-stop-cluster) if appropriate. Registry and storage resources remain. Preserve needed exports and inspect the dedicated lab resource group before deleting it at the end of the project.

Prepared does not mean deployed: Docker builds, AKS API validation, storage
durability checks, TLS, actual cloud resource sizing, and measured load behavior
must be verified in your chosen subscription.
