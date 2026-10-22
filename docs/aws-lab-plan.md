# AWS lab preparation and lifecycle validation

## Curriculum and audit priority - October 22, 2026

Latest user update: there is no separate big lab. The active scope is the seven
portal labs and the underlying AWS knowledge, with a general knowledge audit on
Wednesday, October 28, 2026 (Asia/Saigon). Live lab environments are not required
to remain running for that audit. Pause separate EKS/application migration and
IaC implementation, retaining existing configuration as reference. Earlier
separate mentor-project-audit and two-lab-track plans below are historical.

See the [learning and assessment agreement](aws-learning-alignment.md) for the
SME interview/remediation process and current study window. The user estimates
5-6 focused hours daily and permits weekend study if needed, yielding roughly
30-36 hours through October 27. Prioritize required course work, verify outcomes,
save evidence and follow lab cleanup. Skip optional expansion, not required
content. Measure actual pace and raise schedule conflicts early. End of October
22: main Day 1 practical tests verified, cleanup user-reported with empty scoped
scans, and oral review started. Day 2 has not started. Resume October 23 with a
brief review of the recorded gaps, then the Day 2 portal material and lab. Do not
run Terraform to accelerate it.

## Required execution order - console first

October 22 account clarification: the user checked and there is no group account;
course exercises will run in the user's own existing AWS setup. The supplied
course page's shared-account and mentor-bootstrap assumptions therefore need
adaptation. Inspect its required EC2 role/instance profile, network and access
before execution. The course explicitly includes console and CloudShell/CLI
steps; the main project's mentor-required console-first phase remains in force.
Keep course resource names/tags and cleanup separate from the EKS project, even
though they use the same account. See the current learning alignment notes.

The user subsequently clarified that the existing account is shared with one
other user and there is no naming/tagging convention yet. Treat it as shared:
define distinct Owner values/name prefixes for new resources, preserve the
other user's resources and agree use of shared infrastructure. The personal
budget must filter owned costs; an account-wide budget would count both users.
Owner billing activation and the personal budget remain pending. Do not assume
the Terraform teardown tool owns these course-created or shared resources.

Late October 21 update: the user was instructed to complete the entire required
lab using the AWS Management Console before repeating it with IaC. This takes
precedence over the earlier Terraform-first execution sequence. The user
confirmed that both are console-first: the main AWS/EKS project has an explicit
mentor requirement, and the course hands-on instructions are console-oriented
based on the user's advance reading. Keep each lab's account, evidence and
cleanup scope separate. Exact instructions and shared-account rules have not
been reviewed by the assistant.

1. Review the actual requirements, target account/Region and allowed tools.
   Clarify whether the console requirement covers AWS resource provisioning
   while allowing kubectl/Helm for Kubernetes workloads and verification.
2. Prepare and follow a console build runbook. The user performs changes after
   their purpose, impact, cost, verification and cleanup have been explained.
   Record resource identifiers, important settings, verification evidence and
   dependencies as the build progresses.
3. Complete and verify the console-built lab before beginning the IaC phase.
   Retain existing Terraform as reference material; its historical validation
   does not establish console-lab completion or authorize an apply.
4. Agree the handoff before Terraform manages console-created resources:
   deliberate import/adoption or a separately authorized clean rebuild, as the
   assignment requires. Avoid duplicate resources and unclear ownership.
5. Include console-phase cleanup and the later one-command IaC teardown in the
   lifecycle plan. The foundation destroy tool does not own or automatically
   clean up resources created manually outside its Terraform state.

No cloud provisioning, IAM change, import or deletion is authorized by this
documentation update. The assistant continues to guide rather than execute
cloud changes on the user's behalf.

## Current learning direction - October 21, 2026

New course slides/resources and small hands-on labs are available; no new major
assignment has been released. The user reports finishing Day 1 slides and quizzes;
the supplied screenshot shows a best quiz score of 30/34 (88%), passed. Selected
slides were discussed, not the entire deck. Videos remain unconfirmed and the
multi-part course labs are pending; the apparent shared-account requirement has
not been checked against their actual instructions.

Use the [slide-to-lab alignment and study process](aws-learning-alignment.md).
Teach AWS fundamentals through standalone examples, then connect them to the
existing project/Terraform. The user raised concern that implementation had
outpaced understanding. Use chapter-level explanations and open-ended checks;
the old EKS walkthrough order is now a reference, not the session's fixed agenda.
Next, apply the concepts through short project configuration reviews and failure
scenarios, beginning with root-disk lifecycle in `workers.tf`. No additional
infrastructure implementation or provisioning is requested here. This practice
does not establish course-lab completion or live AWS validation.

## Infrastructure checkpoint - October 19, 2026

The user requested that the remaining **EKS foundation** be implemented locally
first and explained afterward, explicitly **without applying**. This supersedes
the earlier edit-one-block-at-a-time approach for this milestone. Full application
migration is not included in that request.

The foundation configuration is now prepared. Assistant-run validation and three
mocked Terraform tests passed. A fresh read-only AWS plan proposed **57 to add,
0 to change, 0 to destroy**. Nine lifecycle-tool tests passed, including wrong
identity/state, persistent-data refusal, foreign interfaces, unexpected plan
actions, provider failure and mocked orchestration. **No real apply, deployment,
IAM change or destroy was performed.** No persistent data was deleted.

See [the architecture and teaching walkthrough](aws-eks-foundation.md) and
[commands, costs and lifecycle boundaries](../infra/aws/lab/README.md).

Prepared configuration:

| File | Responsibility |
| --- | --- |
| `main.tf` | Provider/profile, expected account/Region, ownership tags, read-only existing-VPC inspection |
| `network.tf` | Two-AZ VPC/subnets, public/private routing, internet gateway and one zonal NAT/EIP |
| `security.tf` | Separate groups and paired rules, worker internal access/HTTPS, control-plane DNS, CloudShell API/HTTPS paths |
| `logging.tf` | VPC Flow Logs delivery role/policy and seven-day logs; seven-day EKS control-plane logs |
| `iam.tf` | EKS service role and worker role with documented baseline managed policies |
| `eks.tf` | EKS 1.35, private API plus administrator `/32` public access, API-based authentication, explicit Service CIDR, standard support |
| `access.tf` | Existing human IAM user access entry and cluster administration association |
| `workers.tf` | Launch template and fixed two-worker managed node group, private AL2023 nodes, encrypted root disks, IMDSv2 |
| `versions.tf` | Pinned Kubernetes, worker AMI/release and compatible managed add-on versions |
| `addons.tf` | CNI, kube-proxy, CoreDNS, Pod Identity Agent and separately scoped CNI trust/association |
| `outputs.tf` | Non-secret identifiers for verification and future CloudShell setup |

The AWS provider remains `6.68.0`. On October 19, read-only Singapore APIs
verified compatible add-on defaults, the pinned AMI owner/architecture/root
device and available AZs. The account identity matched `metronome-lab` in
`206690614118`; the account-plan API reported `FREE` / `ACTIVE`. Planning and
read-only access do not prove service creation eligibility, quota or boot success.

The price script retrieved public on-demand Singapore rates and calculated an
approximate fixed baseline of **$0.27749/hour**, before credits. Transfer, NAT
processing, logs, update surge and taxes are additional. The $20 target is not
an enforced cap. No upgrade, budget, purchase or account setting was changed.

Managed IAM policies and broad worker/internal HTTPS are documented baseline
choices, not a claim of custom minimum permissions. The CNI role has a
permission-by-permission review in the walkthrough; narrow and test modification
scopes before any least-privilege completion claim. EKS's automatically created
cluster security group adds effective permissions beyond the custom group.

## Next session: explanation before cloud changes

### End-of-day checkpoint - October 19

The user requested three final short topics, a daily report, then stopping until
tomorrow. Kube-proxy and CoreDNS were explained with understanding checks. The
user correctly identified stable Service access, rule-based forwarding, separate
Pod IPs, CNI-specific AWS permissions, and DNS returning the Service address.
The CNI -> runtime/kubelet -> API Pod status -> EndpointSlice -> kube-proxy
handoff was explained after the user clarified that this was their question.
Startup ordering was introduced, distinguishing add-on definitions from running
Pods; the final CoreDNS/worker dependency question remains unanswered.

The user estimated **9.5 hours** for today's report. The October 19 report now
uses brief English bullet points across seven copy-ready form fields, per the
user's reporting preference; no external submission occurred. No further code
changes, cloud operations or tests were
performed during this reporting update.

This was the original follow-up plan. On October 20 the user took a personal
day and raised concerns about transferability and incomplete understanding.
The October 21 guide-first direction above supersedes resuming the old sequence
automatically. Keep the CoreDNS/worker, IMDS and IAM review points available
and revisit them when useful to the course. No apply is authorised.

Teach one topic at a time using the completed configuration:

1. Launch template versus managed node group: machine settings versus fleet
   capacity, bootstrap dependencies, worker replacement and update behavior.
2. CNI, kube-proxy and CoreDNS: Pod addresses, Service forwarding and name lookup.
3. Pod Identity: why CNI gets its own AWS role; separate trust, IAM permissions,
   human EKS access and Kubernetes RBAC.
4. Review the full network path, effective security groups, observation, costs,
   state ownership and cleanup.

Check understanding before moving between topics. Do not equate local code
completion with the user having learned it. The full resource/file inventory
requested by the user is now available in the walkthrough and README.

## Deployment gates and remaining live checks

No provisioning is currently requested. Before any later explicit apply request:

- Review current account-plan service restrictions, credit eligibility, EC2/EKS
  quotas and session duration; do not upgrade the account automatically.
- Review effective IAM scope, the current administrator `/32`, ownership and
  the current Terraform plan. Preserve a single backed-up local state.
- Re-run public pricing and inspect the intended teardown scope. Two small
  workers are an unmeasured learning baseline, not full-app capacity evidence.
- Confirm that future CloudShell/controller/storage dependencies have not
  expanded the cleanup boundary beyond the implemented foundation.

After an explicitly requested deployment, verify the actual node group and AZ
placement, two Ready workers, system rollouts, CNI Pod Identity bootstrap,
Service/DNS/HTTPS traffic, logs and metadata restrictions. Add packet-level
allowed/denied NetworkPolicy tests; merely enabling CNI support is insufficient.
Test a deliberate foundation teardown only after an explicit deletion request,
then verify paid resources are absent and reapply can recreate the baseline.
These live tests remain **unexecuted**.

## Terminal and teardown ownership

Local PowerShell owns Terraform and its state. Routine private Kubernetes
administration will use a VPC-connected browser CloudShell once configured.
The restricted public `/32` remains available for local verification and the
external lifecycle owner. A change to private-only access needs a different
external orchestration path first.

`node infra/aws/tools/aws-lab.mjs destroy --confirm-account=206690614118`
is implemented for the **empty foundation only**, with offline tests. It is
destructive and has not been executed against AWS. It validates identity,
state/live ownership, Kubernetes inventory and deletion-only saved-plan actions;
refuses persistent volumes, application objects, load balancers and unknown
interfaces; applies the reviewed plan; and checks state plus selected AWS
leftovers. It preserves local state and never forces finalizers or data deletion.

CloudShell VPC environments are not created by this Terraform root. Their ENIs
deliberately block teardown until the environment owner removes them. Full-app
one-command cleanup remains a later deliverable: stop reconciliation, remove
Gateway resources while the controller is alive, explicitly decide data
retention/deletion, release CloudShell dependencies, then destroy infrastructure.
Do not claim the current command covers those future components.

The existing default VPC, human IAM user/manual account setup, local profiles,
registered domain, local data and shared AWS-managed service-linked roles are
outside the root's destruction scope. Review the manually attached human
AdministratorAccess separately afterward; see [human access](aws-human-access.md).

## Subsequent migration milestones

1. EBS/EFS CSI integration and storage with explicit data retention and recovery,
   including the backup/restore acceptance criteria in DATA-BACKUP-01 below.
2. AWS application overlay, resource requests and enforceable NetworkPolicies.
3. Gateway/ALB controller and IAM, DNS/certificates, Cognito and operator allowlist;
   real session expiry, redirects, MFA, authorization and logout integration tests.
4. Replay assets in S3/CloudFront with pinned self-hosted assets, caching/range
   tests and no public Showdown dependencies.
5. Full-app GitOps and digest promotion; keep GHCR for now. Existing simulator
   GitOps is not a full AWS deployment. No automatic tournament on deployment.
6. Full-app lifecycle/recovery evidence and one-command teardown; Rancher and
   metric-driven node autoscaling follow a working baseline when needed.

Preserve Azure as a reference. Terraform owns AWS infrastructure; Kubernetes
manifests own workloads/routing/policies; the load balancer controller owns its
ALBs/target groups. Never give two tools ownership of the same resource.

## Schedule and daily reporting

The current assignments are supplementary practice. As of October 21 no new
major lab has been released. Course slides and smaller hands-on exercises are
available instead. There is no confirmed release date or deadline for a new
major assignment. Adapt when it arrives; do not claim all original networking/
autoscaling assignments are met.

Monday morning was a meeting; the user estimated 9.5 hours for October 19.
The [October 19 report](daily-reports/2026-10-19.md) records completed work,
validation evidence and limitations. Do not count assistant-added topics as
already learned or report a deployment that has not occurred. Daily reporting
is in-session preparation, not an unattended job or external submission.

On October 21, the user completed Day 1 slides/quizzes (30/34, 88%, screenshot)
and discussed three project review scenarios: worker loss/snapshot recovery,
trust versus permissions, and EBS/EFS selection. See the
[October 21 report](daily-reports/2026-10-21.md); estimated working time is 7.9
hours, excluding the user-reported 1.5-hour lunch break from the 9.4-hour total.
The user expects a project audit next week covering implementation reasoning
and general AWS, possibly Kubernetes. Treat this as an expectation until the
mentor confirms the date, scope and required evidence.

## Pinned follow-up: DATA-BACKUP-01 - application backup and restore

Status: identified during October 21 learning review; not implemented. A bounded
search of AWS Terraform, Kubernetes manifests, workflows, scripts and relevant
runner/publication files found recovery state and completed archive copying,
but no configured application backup schedule or storage-loss restore workflow.
Codebase Memory was unavailable (`Transport closed`); source reads were used.
This is repository evidence, not a live AWS account inventory.

- Define acceptable data loss (RPO), recovery duration (RTO), schedule and
  retention before choosing backup frequency or cross-Region/account copies.
- Runner: plan EBS snapshots with a tested application-consistency procedure
  covering metadata, roster, accepted-result log and checkpoint. Graceful
  restart tests are not a substitute for restoration from a separate backup.
- Completed archives: plan EFS backups with retained recovery points. Publication
  into a separate directory does not establish an independent failure boundary.
- Protect Terraform state separately. Git and image digests do not back up
  tournament data or Terraform's resource ownership records.
- Restore into isolated storage and validate run identity, accepted-result
  integrity, resumability where permitted, and archive serving. Record measured
  recovery evidence and actual backup/resource charges after authorized testing.
- Include backup permissions, encryption, retention costs, inventory and an
  explicit keep/delete decision in lifecycle documentation. One-command teardown
  must account for retained backups without silently deleting recovery data.

Do not create backups, restore/delete data, change IAM or apply infrastructure
as part of this planning note. Implement and test only within later authorized
storage work.

## Pinned follow-up: NET-EGRESS-01 - destination-restricted egress

Status: deliberately deferred at the user's request. Revisit after the initial
working lab and lifecycle tests, and before describing the design as production
egress hardening. Revisit sooner if grading requires destination restrictions.

Initial compromise: outbound TCP 443 to any IPv4 destination through NAT,
alongside application NetworkPolicies. This permits arbitrary destinations on
443; it does not restrict traffic to GitHub, GHCR, or approved AWS services.
NAT supplies translation and routing, not a domain allowlist. Ordinary security
groups and standard Kubernetes NetworkPolicies do not accept hostname rules.

Evaluate these complementary improvements before choosing an implementation:

- A forward proxy with an explicit domain allowlist. Configure Argo CD and
  relevant node/container-runtime clients to use it, and block direct bypass.
  An application Pod's proxy settings do not configure worker image pulls.
- AWS Network Firewall domain filtering. Review TLS server-name matching limits,
  routing, Availability Zones, logging, regional eligibility, and ongoing cost.
- ECR plus the required VPC endpoints for private AWS image/API access. This can
  reduce external dependencies, but does not provide private access to GitHub.
- Workload egress restrictions with a verified policy engine. Pod controls and
  node/container-runtime image-pull controls must be tested separately.

Acceptance tests for the eventual improvement:

1. Argo CD can fetch the intended repository; workers can pull required images;
   controllers, identity/key discovery, and required AWS APIs still work.
2. An unapproved destination is blocked, including on TCP 443.
3. Direct connections cannot bypass a required proxy. Merely setting a proxy
   environment variable while direct HTTPS remains allowed is insufficient.
4. Verify DNS, authentication, image download/CDN dependencies, logs, and failure
   behavior. An expired Git/registry credential must be distinguishable from a
   network denial; private repository and image permissions are separate.
5. Extend Terraform/manifests, cost estimates, and teardown coverage to include
   every proxy, endpoint, firewall, and log resource that is introduced.

References: [AWS outbound controls](https://docs.aws.amazon.com/prescriptive-guidance/latest/secure-outbound-network-traffic/restricting-outbound-traffic.html),
[EKS private dependencies](https://docs.aws.amazon.com/eks/latest/userguide/private-clusters.html),
[domain filtering](https://docs.aws.amazon.com/network-firewall/latest/developerguide/stateful-rule-groups-domain-names.html).
