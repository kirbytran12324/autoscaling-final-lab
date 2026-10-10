# Development digest promotion

The current local Argo CD development overlay manages only the simulator.
`scripts/prepare-dev-promotion.py` validates the complete five-image release
record and previews the simulator digest override and PostSync smoke resource
for that overlay. It does
not build, publish, commit, push, contact Kubernetes, or start a tournament.
Production configuration and persistent data are outside its write scope.

Install the existing validation dependencies if needed:

```powershell
python -m pip install -r scripts/requirements-validation.txt
```

Preview a release using the source commit, workflow run ID, and attempt from
the successful publishing run. Supply these expectations independently of the
downloaded JSON:

```powershell
python scripts/prepare-dev-promotion.py release.json --expected-commit <full-commit-sha> --expected-run <run-id> --expected-attempt <attempt>
```

The script rejects mismatched metadata, missing or extra images, unexpected
image repositories, malformed digests, and duplicate JSON keys. It uses the
Kustomize `newName` and `digest` fields and removes the previous tag override.
Preview mode does not change any files. `--write` updates only the local
`k8s/gitops/overlays/dev/kustomization.yaml`, preserving unrelated settings.
`--write --record` also writes `release-selection.json` beside it with the
complete release and previous image/release selection. Both files are committed
together by the workflow. A local write alone does not deploy anything.
Undo an unwanted local update by restoring that file from its pre-edit copy
or selectively discarding the helper's image-block diff.

Before committing an update, inspect the diff and render it offline:

```powershell
git diff -- k8s/gitops/overlays/dev/kustomization.yaml
kubectl kustomize k8s/gitops/overlays/dev
git diff --check
```

Run the offline helper safety checks with:

```powershell
python scripts/test-dev-promotion.py
```

## Automatic development flow

The `promote-dev` job in `release.yaml` runs after the complete reusable
verification/publishing workflow succeeds, on `main` in this repository, and
only when the repository Actions variable `AUTO_PROMOTE_DEV` equals `true`.
It is disabled when that variable is absent.

The job downloads `verified-release-<attempt>` from its own run, supplies the
run's expected metadata, and prepares the same digests without rebuilding.
`scripts/validate-dev-promotion.py` renders the candidate and checks its image,
namespace, workload and smoke-hook boundaries before Git can publish it.
Only the development Kustomization and selection record are staged.

Promotion is serialized. The source SHA must still equal `origin/main` when
the job starts. Any intervening commit, including a documentation commit,
causes a conservative skip. A normal Git push also rejects a concurrent
update after that check; it never force-pushes or rebases an old release onto
newer source. If that happens, inspect the newest publishing run; explicitly
dispatch the publishing workflow on current `main` if it has no run.
Rerun all jobs when retrying an attempt so all five records exist for it.

The job uses the built-in short-lived `GITHUB_TOKEN` through checkout and
requests repository write permission only for promotion. Branch rules may
reject that push; the job then fails without bypassing the rules. If direct
bot updates are prohibited, use a reviewed promotion PR or an explicitly
approved GitHub App policy instead. Do not disable protections as a workaround.

The workflow summary reports that desired state was committed, not that the
deployment passed. GitHub-hosted runners cannot directly reach this machine's
local Kubernetes API. Argo CD waits until the rollout is Healthy and then runs
the `metronome-dev-smoke` PostSync Job inside the cluster. The Job uses the same
simulator digest, tests live/readiness through the Service, has no persistent
volumes or Kubernetes API token, and cannot start a tournament. It has a
120-second deadline and no retries. Success/failure logs remain until the next
sync replaces the previous smoke Job. Do not use selective sync: it skips hooks.
Require the expected Git revision, a Succeeded sync operation, Healthy rollout
and a successful smoke result before treating development as verified.

## Activation after review and merge

1. Review the workflow and merge it through passing PR CI. This introduces
   local configuration; promotion remains disabled until the variable is set.
2. Confirm Docker Desktop is running and the selected context is
   `docker-desktop`. Confirm the cluster can pull the published GHCR simulator
   image. Private packages require separately configured pull access.
3. Inspect and apply `k8s/gitops/argocd/dev-project.yaml` to allow Argo CD to
   manage `batch/Job` in `metronome-dev`. This expands that project's resource
   allowlist; it creates no smoke Job by itself. It has no AWS cost. Verify the
   allowlist after applying. Removing the added Job entry reverses the permission
   change, but do that only after removing the desired smoke hook.

   ```powershell
   kubectl --context docker-desktop diff -f k8s/gitops/argocd/dev-project.yaml
   kubectl --context docker-desktop apply -f k8s/gitops/argocd/dev-project.yaml
   kubectl --context docker-desktop -n argocd get appproject metronome-dev -o yaml
   ```

4. In GitHub repository Settings > Secrets and variables > Actions > Variables,
   create the repository variable `AUTO_PROMOTE_DEV` with value `true`. This
   authorizes future successful main releases to commit development desired
   state automatically. It consumes normal Actions runner time and local
   cluster CPU/memory, and provisions no AWS resources. Delete the variable or
   set it to `false` to stop future promotion; let any already-running job finish
   or explicitly cancel it. Repository workflow permissions and branch rules
   must permit the bot's normal push.
5. Trigger Publish Verified Images on `main`, or let the next source merge
   trigger it. Inspect the promotion summary, then Argo CD's sync revision,
   operation result and smoke Job logs:

   ```powershell
   kubectl --context docker-desktop -n metronome-dev rollout status deployment/metronome-simulator --timeout=180s
   kubectl --context docker-desktop -n metronome-dev get job metronome-dev-smoke
   kubectl --context docker-desktop -n metronome-dev logs job/metronome-dev-smoke
   kubectl --context docker-desktop -n argocd get application metronome-dev -o yaml
   ```

Production is outside this automation. Its existing Argo application still
tracks its separate overlay; changes to that desired state require controlled
promotion. The control API and full application are not added to this simulator
development overlay by this change.

## Failure and recovery

A failed rollout or smoke hook fails the Argo sync operation. It does not
automatically roll back or report a successful deployment in GitHub. Inspect
events/logs and correct the cause or promote a known working digest. To recover
the previous desired state, disable promotion and revert only the promotion
commit through your normal Git review flow; this restores both the previous
Kustomization and selection record. For the first promotion, the previous
image is a local tag and may not be available on every node, so confirm its
availability before choosing that recovery. Prefer a known published digest.
Retry the full Argo sync and smoke check after repair. Never delete PVCs,
active state or completed archives as part of recovery.

The publishing workflow excludes `k8s/gitops/**` from its push paths so a
GitOps-only promotion commit does not publish fresh images. Pull-request CI
still validates changes. Release-record validation checks consistency; it does
not independently establish registry provenance or detect arbitrary tampering.

References: [Argo sync phases and hooks](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/),
[GitHub workflow triggering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
