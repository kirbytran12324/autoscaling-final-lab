# AWS EKS learning foundation

October 22 scope update: the active assignment is now the seven portal course
labs, with a general knowledge audit on October 28. Separate EKS/application
implementation is deferred. Preserve this configuration as reference; do not
apply it as part of the course-lab sprint. The execution-order notes below
describe the earlier project plan.

Execution order updated October 21: the required lab must be completed in the
AWS console before its IaC implementation. Keep this prepared configuration as
a reference until that phase is complete. This applies to the main AWS/EKS
project by explicit mentor request, alongside the console-oriented course labs.
Their account/cleanup boundaries and the later import-versus-rebuild handoff
still need review. Terraform state and the foundation teardown tool do not
automatically own console-created resources.

Local configuration is complete for the first EKS foundation. On October 19,
2026, Terraform validation, three mocked Terraform tests, nine lifecycle-tool
tests, and a real read-only AWS plan passed. The plan proposed **57 creates,
zero updates, zero deletions**. Nothing has been applied or destroyed.

This prepares a Kubernetes platform; it does not deploy the tournament app.
Read [the file-by-file walkthrough](../../../docs/aws-eks-foundation.md) before
considering a future deployment. The Azure reference and current GHCR release
pipeline are preserved.

## What Terraform would create

- VPC `10.30.0.0/16`, two public and two private subnets across Singapore AZs
  `a` and `b`, route tables, an internet gateway, and one zonal NAT/public IPv4.
- Custom worker, EKS, EFS-placeholder, and CloudShell security groups.
- VPC Flow Logs and EKS API/audit/authenticator logs, retained for seven days.
- EKS `metronome-lab`, Kubernetes `1.35`, private API access and a public API
  restricted to the administrator's `/32`; explicit human cluster access.
- One managed group with two `t3.medium` Amazon Linux 2023 workers, private
  addresses, encrypted 30 GiB gp3 root disks, and IMDSv2 with hop limit 1.
- Managed VPC CNI, kube-proxy, CoreDNS, and Pod Identity Agent add-ons.
  CNI uses a separate Pod Identity role; NetworkPolicy support is enabled.

The AWS EKS AMI and add-on versions are pinned in `versions.tf`; the AWS
provider remains locked to `6.68.0`. The AMI root-device mapping and compatible
add-on defaults were verified using Singapore read-only APIs on October 19.
Region validation rejects other Regions until their AZ/image pins are reviewed.

Not included: application workloads, actual EBS data PVCs/EFS, CSI storage
drivers, ALB/Gateway controller, Cognito, certificates/DNS, S3/CloudFront,
Argo CD expansion, Rancher, autoscaling, or a CloudShell VPC environment.
The empty EFS security group does not create a filesystem. No application
NetworkPolicies exist yet; enabling the policy engine alone does not isolate Pods.

## Local validation commands - safe to run now

Use PowerShell in the repository. Terraform is the sole local state owner;
keep state and its backups out of Git. Never create a second independent state
in CloudShell. The existing default VPC is read, not adopted for management.

The provider uses the existing `metronome-terraform` credential-process profile,
backed by `metronome-lab`. It checks the account ID before operating. Renew the
user session when it expires; do not copy credential values into Terraform.

```powershell
aws login --profile metronome-lab --region ap-southeast-1
terraform -chdir=infra/aws/lab init -lockfile=readonly
terraform -chdir=infra/aws/lab fmt -check -recursive
terraform -chdir=infra/aws/lab validate
terraform -chdir=infra/aws/lab test
node --test infra/aws/tools/foundation-guards.test.mjs
terraform -chdir=infra/aws/lab plan
```

The ignored `lab.auto.tfvars` supplies `admin_ipv4_cidr = "YOUR.IP.ADDRESS/32"`.
Update it after moving networks if you need local Kubernetes API access. This
is unrelated to Terraform's ability to call the public AWS management APIs.
Do not use `0.0.0.0/0` for the API. AWS IAM and EKS access entries still apply.

Combined read-only check, including identity/default-workspace checks:

```powershell
node infra/aws/tools/aws-lab.mjs check
node infra/aws/tools/pricing.mjs
```

These require `aws`, `terraform`, and Node.js on PATH. The tools accept
`TERRAFORM_BIN` if Terraform is installed outside PATH. AWS commands use the
explicit lab profile and Region. The pricing tool uses the public Price List
API in `us-east-1` to quote **Singapore** products; it does not create resources.

## Cost and deployment gates

The October 19 Price List API quote estimates **$0.27749/hour**, approximately
**$2.22 for eight hours** or **$6.66 for 24 hours**, before credits. It includes
two workers, 60 GiB of gp3 using a 730-hour monthly approximation, one NAT,
one public IPv4, and standard EKS cluster hours. NAT processing adds $0.059/GB.
Logs, cross-AZ/internet transfer, update surge, taxes, and later services are
excluded. Re-run the quote before deployment; the $20 target is not a cap.
See the [AWS Price List API](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_pricing_GetProducts.html).

The read-only account-plan API returned `FREE` / `ACTIVE` on October 19.
This is not evidence that every create operation or EC2 quota is available.
Check current account restrictions, credit eligibility and regional quotas
before apply. No account upgrade is part of this configuration.

Additional gates: review the IAM managed-policy scopes, current `/32`, latest
plan, intended session duration, state backups, and cleanup coverage. Two small
workers are a platform learning baseline, not measured capacity for the full app.
Default managed-node updates may temporarily exceed steady-state size; minimum,
desired, and maximum two are not a hard spending limit.

## Later live verification - not run yet

After an explicitly requested deployment:

```powershell
node infra/aws/tools/aws-lab.mjs verify
```

This performs read-only AWS/Kubernetes checks using a temporary kubeconfig,
without changing the default kubeconfig or Docker Desktop context. It checks
two Ready nodes, system rollouts and add-on health. It also refuses unexpected
application objects, because this command validates an empty foundation.
It needs `kubectl` on PATH and network access through the allowed public `/32`.

Routine administration can later use a VPC-connected CloudShell with the output
subnet/group IDs. Its files are ephemeral. Its environment is not created here.
Packet-level DNS, allowed/denied NetworkPolicy connections, Pod Identity/CNI
bootstrap, logs, AMI rollout behavior, and full lifecycle testing await AWS.
Do not describe planning or mocked tests as live integration evidence.

## Later single-command foundation teardown - destructive, not run yet

Impact: terminates workers, deletes their root disks and cluster, removes lab
networking/IAM, and deletes both log groups including their records. Export any
required logs first. This is intentional full teardown, not rollback.

```powershell
node infra/aws/tools/aws-lab.mjs destroy --confirm-account=206690614118
```

The command verifies identity, default workspace, state addresses/ownership,
live cluster/VPC identity, Kubernetes inventory, load balancers and network
interfaces. It refuses PVs/PVCs, application workloads/namespaces, unknown
resources and interfaces such as CloudShell ENIs. It then generates and checks
a deletion-only saved plan, applies that exact plan, verifies state and selected
AWS leftovers, and preserves state. Failures stop the process; it never forces
finalizers or deletes unreviewed storage. Its guards and orchestration have
offline tests; the actual destructive operation has not been run.

Delete a later CloudShell VPC environment through its owner before this command;
it deliberately refuses to guess how to delete that environment. Extend and
retest orchestration before adding controllers/storage or claiming one-command
teardown of the **full application**. An empty state is not an account-wide
orphan inventory. Existing default VPC, IAM user, local profiles, domain, local
data, and shared AWS-managed service-linked roles remain outside this root.
