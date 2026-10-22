# Delivery verification

Image publication, desired-state promotion and observed deployment are separate
results. The existing local GitOps extension remains optional. None of the
checks below migrates the application to AWS or provisions infrastructure.

## CI gates and exact images

The reusable CI workflow tests all four Node packages on Ubuntu and Windows.
Frontend builds run on both; browser controls and packaged container checks run
on Linux. Each of the five production images is built once, tested, and then
pushed unchanged when publication is enabled. `verified-release-<attempt>`
records their digests, source commit, workflow URL and attempt. Promote the
recorded digest rather than rebuilding or relying on a reusable tag.

`AUTO_PROMOTE_DEV=true` enables development desired-state promotion on the main
repository's `main` branch. A newer main commit makes an older release
ineligible; a concurrent update rejects the normal Git push. The release
selection record retains the previous image and release. This automation does
not change the production-named local learning overlay.

The release summary prints the **promotion commit** after the desired-state
push. This differs from the **source commit** used to build the image. Argo must
observe the promotion commit. A green publishing workflow proves publication
and, when enabled, the desired-state push; live deployment remains unverified
until the separate observation succeeds. Re-run all jobs when recovering an
image-matrix release failure: artifact assembly requires records from the same
workflow attempt and will refuse partial records.

## Offline Terraform checks

CI pins Terraform `1.16.5` and uses the committed provider lock file. Its commands
are:

```powershell
terraform -chdir=infra/aws/lab fmt -check -recursive
terraform -chdir=infra/aws/lab init -backend=false -lockfile=readonly -input=false
terraform -chdir=infra/aws/lab validate -no-color
terraform -chdir=infra/aws/lab test -no-color
node --test infra/aws/tools/foundation-guards.test.mjs
```

Initialization downloads the locked provider; it does not initialize a remote
backend. All Terraform test runs use `mock_provider "aws"` and plan-only commands.
There are no AWS credentials in this job and no real plan, apply, account
discovery, or teardown. Future tests must preserve this offline contract. Local
provider-process communication may require execution outside an application
sandbox; that is distinct from requesting cloud access.

When selecting or updating a provider, generate content checksums for both the
Linux CI runner and Windows development before committing the lock file:

```powershell
terraform -chdir=infra/aws/lab providers lock -platform=linux_amd64 -platform=windows_amd64
```

This command downloads packages from their origin registry and updates dependency
metadata without configuring AWS. Review the selected version and signed package
checksums, then commit `.terraform.lock.hcl`. Preserve both platforms' `h1:`
content hashes: CI's read-only initialization cannot save a newly computed hash
for later validation of the unpacked provider. A verified archive download alone
does not establish that subsequent cached-package validation will pass. Keep
`-lockfile=readonly` in CI rather than allowing jobs to silently repair the lock.

## Pinned manifest schema checks

```powershell
python -m pip install -r scripts/requirements-validation.txt
python scripts/install-kubeconform.py
python -m unittest discover -s scripts/test -p 'test_delivery*.py'
python scripts/test-dev-promotion.py
python scripts/validate-manifests.py --schema
```

The installer supports Linux/Windows amd64, verifies the published archive's
checked-in SHA-256, and writes only ignored `.validation/tools/` tooling. The
validator requires kubeconform `v0.7.0`, Kubernetes `1.35.0` strict schemas at
immutable schema repository commit
`b2ba4defe30ed5a0104987433896f1fd32807304`. Schema downloads use HTTPS; these
commands never contact a Kubernetes API. `KUBECONFORM_BIN` can select a binary
at another location, but the version check still applies. Missing schemas fail;
the validator never uses `-ignore-missing-schemas`. A render-only diagnostic
remains available without `--schema` and does not count as schema validation.

The following exact API/kind pairs have explicit exceptions because this
repository does not pin the installed controllers' CRD schemas:

| API | Kinds | Required follow-up before deployment |
| --- | --- | --- |
| `argoproj.io/v1alpha1` | `Application`, `AppProject` | Validate against the installed Argo CD CRDs |
| `gateway.networking.k8s.io/v1` | `Gateway`, `HTTPRoute` | Validate against the optional gateway installation's CRDs |
| `autoscaling.k8s.io/v1` | `VerticalPodAutoscaler` | Validate against the installed VPA CRD |

Every occurrence is reported separately from validated core-resource counts.
Other kinds or API versions are not exempt. As controller installations become
pinned, replace their exceptions with pinned schemas. Core schema checking also
does not cover every admission rule or installed capability. A separately
authorized deployment must still perform the documented server-side dry run,
rollout wait and smoke checks for the intended cluster.

## Deterministic PostSync smoke

The development hook checks both health endpoints, then submits one
`Snorlax`/`Clefable` battle with seed `[12345,23456,34567,45678]` and a 100-turn
cap. It validates the pinned `pokemon-showdown@0.11.11` golden response:
Snorlax wins naturally in five turns with protocol hash
`51889bae250badd20a432969b994b9aa9bf12818e4fe90afc60394c4d618f3e9`.
The source vector is also covered by the simulator's deterministic engine test.
Engine/rules upgrades must deliberately review both goldens. Hostname and
duration are excluded because they are runtime observations. This is one short
stateless battle, not a tournament or a stored accepted result.

## Optional live deployment observation

No workflow automatically starts an observer or queues a private runner. The
manual **Verify Development Deployment** workflow requires existing configuration:

- An online dedicated self-hosted runner with Python and `kubectl` already on
  PATH. Use a dedicated label such as `metronome-local-reader`.
- Repository variable `DEV_VERIFY_RUNNER` set to that dedicated label.
- Repository variable `DEV_VERIFY_CONTEXT` set to its existing Kubernetes
  context. Use preconfigured read-only access: get the `metronome-dev`
  Application in `argocd`, and the simulator Deployment and smoke Job in
  `metronome-dev`. No tool bootstraps identities, credentials or cloud access.

Runner installation, connection, RBAC and credential changes are separate
explicitly authorized work. Review self-hosted runner security before using one;
the observer checks out trusted main code and accepts only promotion revisions
that are ancestors of main. Never use a privileged general-purpose runner for
untrusted pull requests.

Dispatch with the full desired-state promotion SHA and `runner_ready=true`
only after checking the configured runner is online. A hosted preflight fails
on missing/invalid variables, a generic runner label, unconfirmed readiness, or
a revision outside main before scheduling the private observer. If the runner
goes offline after confirmation, cancel the queued run and dispatch again when
it is available. Default release publication never invokes this workflow.

The observer uses explicit-context `kubectl get` and a context lookup only. It
requires the exact sync revision, Healthy status, a successful operation for
that revision, and its successful `PostSync` hook result. It checks observed
Deployment generation, updated/available/ready replicas and the selected image
digest. The completed smoke Job must fall within that operation's timestamps;
an old successful Job cannot satisfy a newer release. Argo status is read again
before reporting success to detect a concurrent sync. Polling is bounded to
five minutes by default. Failed checks do not mutate or roll back anything.

For local observation, use the selection file from the promoted checkout:

```powershell
python scripts/verify-dev-deployment.py --context <existing-read-only-context> --revision <promotion-commit-sha> --selection <promoted-checkout>/k8s/gitops/overlays/dev/release-selection.json
```

Keep the publishing check and observation check visible separately when
reviewing a release. This change has fixture coverage; live cluster verification
still requires an explicitly requested run against a configured environment.

## Recovery

On a failed deployment, inspect Argo's operation and the retained smoke Job
before choosing a recovery. Revert the development selection commit or select
the previous verified digest recorded in `release-selection.json`, review the
rendered change, and use the normal controlled Git promotion process. Verify
the new recovery commit with the same observer. Never rebuild an old revision
to approximate its previous image, force-push over a newer promotion, or delete
PVCs/completed-run data as part of rollback. Persistent data is outside this
simulator-only promotion and observer.
