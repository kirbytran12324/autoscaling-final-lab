# AWS human administrator access

## Recorded setup - October 16, 2026

`metronome-lab` is the human administrator for this single-user AWS learning
account. It is separate from the service and automation roles Terraform will
create. The user existed before the Terraform infrastructure lab.

| Item | Recorded value |
| --- | --- |
| AWS account | `206690614118` |
| IAM user | `metronome-lab` |
| User ARN | `arn:aws:iam::206690614118:user/metronome-lab` |
| Lab Region | `ap-southeast-1` (IAM permissions are not restricted to this Region) |
| Console authentication | Enabled with MFA, as shown in the user-provided IAM screenshot |
| Local CLI profile | `metronome-lab`, authenticated through `aws login` |
| Terraform profile | `metronome-terraform`, forwarding temporary credentials from the CLI profile |
| Billing console IAM access | Activated by the user through the root console |
| Configuration owner | Account administrator; manually established account bootstrap |

Evidence: the user supplied screenshots showing billing IAM access as
**Activated** and three directly attached policies on this user. These confirm
the displayed configuration, not an independent API inventory or successful
provisioning test. The user subsequently confirmed that billing access works
when signed in as `metronome-lab`; this is user-reported functional verification.
No credentials, MFA seeds, or login-session material belong in this document.

## Human responsibilities

| Responsibility | Tasks |
| --- | --- |
| Infrastructure lifecycle | Terraform plan/apply, configuration updates, failure recovery, and authorised teardown |
| IAM administration | Inspect and manage lab roles, policies, trust relationships, service-role assignments, and automation access |
| Resource inspection | Inspect VPCs, subnets, routes, security groups, EKS, workers, storage, load balancers, certificates, and Cognito |
| Monitoring and troubleshooting | Inspect metrics, dashboards, alarms, logs, VPC Flow Logs, and CloudTrail |
| Cost management | Inspect usage, credits, billing, and budgets; configure budget alerts |
| Cluster administration | Establish EKS access and perform authorised kubectl/Helm deployment and diagnostics |
| Supporting setup | Manage lab CloudShell environments, inspect quotas, and configure AWS-managed DNS where selected |
| Cleanup and evidence | Export evidence, investigate deletion failures, and inspect for leftover resources |

Namecheap account access and application operator login are separate from this
AWS identity. CloudShell uses the signed-in console identity, so routine work
must use the intended IAM user rather than the root console session.

## Attached policies and access decision

All three policies were shown as directly attached in the supplied screenshot.

| AWS-managed policy | ARN | Purpose / review |
| --- | --- | --- |
| `AdministratorAccess` | `arn:aws:iam::aws:policy/AdministratorAccess` | Newly attached for human account administration, infrastructure lifecycle, troubleshooting, and access recovery |
| `AmazonVPCReadOnlyAccess` | `arn:aws:iam::aws:policy/AmazonVPCReadOnlyAccess` | Existing policy used for the original VPC inspection exercise; redundant while administrator access is attached |
| `SignInLocalDevelopmentAccess` | `arn:aws:iam::aws:policy/SignInLocalDevelopmentAccess` | Existing permission for local development sign-in; also covered by the administrator policy while attached |

`AdministratorAccess` allows `Action: "*"` on `Resource: "*"`. This is a deliberate
human account-administration choice for the dedicated learning account, not a
claim that every AWS action is necessary for Terraform or that this is a
least-privilege deployment policy. It also permits operations outside the lab
resources and Region. The administrator remains subject to applicable explicit
denies and other AWS policy controls; root-only operations still require root.

No additional service-specific FullAccess or billing policy is needed alongside
this policy. Billing console access also requires the account-level IAM access
setting, which is now activated. Neither granting the policy nor activating the
setting provisions infrastructure or upgrades the account plan. Administrator
access permits billable operations; the $20 credit-consumption target is not an
enforced spending cap.

Continue using MFA and temporary CLI credentials. Do not distribute this human
identity's credentials to GitHub Actions, Pods, controllers, or AWS services.
Those identities require their own scoped access. Signing in as root in the
browser does not change the identity used by local Terraform.

## Separate Kubernetes access

AWS IAM administrator permissions do not alone establish Kubernetes API access.
The planned cluster configuration will explicitly grant the human identity an
EKS access entry with `AmazonEKSClusterAdminPolicy` at cluster scope:

`arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy`

This is an EKS access policy, not another IAM policy attached to the user.
No lab EKS cluster or access entry has been deployed. Endpoint routing,
security groups, and the public endpoint CIDR restriction remain separate
connectivity requirements.

## Verification still required

Run these read-only checks from the user's local PowerShell session:

```powershell
aws sts get-caller-identity --profile metronome-terraform --region ap-southeast-1 --no-cli-pager
aws iam list-attached-user-policies --user-name metronome-lab --profile metronome-lab --output table --no-cli-pager
```

The first result should identify the expected account and `metronome-lab` user;
the second should match the three policies above. Console billing access as
`metronome-lab` is confirmed by the user; the CLI inventory checks above remain
pending. Verify actual cluster access after EKS deployment. A successful Terraform plan is not evidence
that apply, Kubernetes access, or teardown has passed.

## Teardown and assignment boundary

- Terraform does not own this pre-existing user, its original two attachments,
  the new manual administrator attachment, or the account-level billing setting.
  Do not import or delete them implicitly during lab destruction.
- Remove Terraform-created service/workload roles and cluster access entries
  with their lab resources. Keep provisioning access until infrastructure
  cleanup and leftover verification have finished.
- Include a final review of the new `AdministratorAccess` attachment after
  grading and teardown. Removing it requires an explicit action; retaining it
  for later account administration requires an explicit documented decision.
  The current teardown command is not implemented and does not automate this
  access review or removal.
- Treat this account bootstrap boundary as a documented interpretation of the
  assignment, not an explicit exemption granted by its text. If grading includes
  bootstrap access in the single-command cleanup scope, extend the cleanup
  design before claiming compliance.
- This user record does not replace the assignment's permission-by-permission
  review of a created IAM role. Prepare that separate review for a lab service
  role and add live verification after deployment.

## References

- [AdministratorAccess policy](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AdministratorAccess.html)
- [VPC inspection policy](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonVPCReadOnlyAccess.html)
- [Local development sign-in policy](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/SignInLocalDevelopmentAccess.html)
- [Billing console access](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/control-access-billing.html)
- [IAM security practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
- [EKS access entries](https://docs.aws.amazon.com/eks/latest/userguide/access-entries.html)
- [EKS access policies](https://docs.aws.amazon.com/eks/latest/userguide/access-policy-permissions.html)
