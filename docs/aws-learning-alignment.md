# AWS slide and lab alignment

## Learning and assessment agreement - October 22, 2026

The user's October 22 update establishes the portal curriculum as the source of
truth for learning and the general audit. These are user-supplied program rules,
not a claim that the assistant has reviewed the entire portal or lab brief.

Latest scope update: there is no separate big lab to deliver. All seven portal
labs and their underlying AWS concepts are the current learning scope. The audit
is Wednesday, October 28, 2026 (Asia/Saigon), focused on general understanding
rather than a live lab environment. Pause the separate EKS/application migration
and Terraform implementation; preserve existing work as reference. The earlier
plan for a separate mentor project-lab audit is superseded for this effort.

- Follow the subject's defined duration and required theory, videos, official
  references, labs and assessments with mentor support. The supplied AWS outline
  specifies seven learning days. The latest user update sets the October 28
  audit deadline; do not treat an 88% Day 1 quiz result as subject completion.
- Use project examples to reinforce the syllabus. Do not let EKS implementation
  displace required course topics or add features solely for an imagined audit.
  Official references and practical scenarios deepen the required material;
  interview follow-ups may also draw on claimed project experience.
- The current assessment is the general knowledge audit based on the course.
  The previously supplied process describes a direct SME interview with the
  mentor observing and supplementing when needed. Do not add an EKS project
  demonstration or unrelated Kubernetes material to the required AWS syllabus.
- The SME review should expose current understanding, difficulties and learning
  results so the auditor can clarify gaps and give practical direction. It also
  contributes to assessment; coaching should support honest explanations rather
  than hide uncertainty or rehearse claims unsupported by work.
- Normally plan for one SME audit. The stated process allows at most two: if
  the first is unsuccessful, a different SME conducts the second after syncing
  with the first. Course completion requires auditor confirmation of sufficient
  understanding. If both reviews are unsuccessful, the program may move the
  intern to another subject while mentor-led revision addresses SME feedback;
  this is not a pass or automatic completion.
- Program reports and SME evaluations are intended to be visible in the portal;
  the evaluation feature is described as under development. Keep concise,
  evidence-based progress and gap records without claiming portal submission or
  evaluator approval.

### Study window: October 22-27, audit October 28

The user estimates 5-6 focused hours per day and explicitly makes the weekend
available if needed. Six days through Tuesday provide approximately 30-36 hours;
this is an estimate, not hours already worked. The seven-day course needs a
compressed schedule. No claim that all remaining requirements fit is justified
until the lab/video scope and actual pace are checked. This temporary weekend
availability supersedes the old Azure plan's protected-weekend assumption.

Today's target: finish the required Day 1 lab, verify its results, record brief
evidence/explanations and complete its cleanup; then start Day 2. Follow the
portal sequence over the remaining days, adjusting targets after today's actual
pace is known. Protect a final review block on Tuesday where possible. Raise a
time/scope conflict with the mentor early rather than silently skipping required
labs, videos or assessments. Optional challenges and unrelated project work can
wait.

Use this loop for each meaningful lab section:

1. Read the relevant portal material and required video/reference content.
2. Explain the purpose and one important mechanism, then perform the steps.
3. Verify an observable outcome and save concise, non-secret evidence.
4. Ask for a short explanation or failure prediction in the user's own words;
   deepen only where the explanation exposes a gap.
5. Complete the prescribed cleanup, verify relevant leftovers and record gaps
   for retrieval practice the following day. Do not keep billable environments
   running for the audit. Preserve any required data/evidence before cleanup.

Record per module: theory/video status, quiz result, lab verification, cleanup
status and unresolved concepts. Day 1 theory and quiz are reported complete;
videos remain unfinished/unconfirmed. The main Day 1 practical tests are now
verified and the user reports cleanup complete with empty scoped scans. The
budget exception and final knowledge review remain open. Days 2-7
completion and exact lab instructions have not been verified. The supplied
outline spans scaling/databases (Day 2), delivery/storage (Day 3), containers and
serverless (Day 4), networking/DR (Day 5), operations/security (Day 6), and
data/IaC/design (Day 7); do not infer individual lab requirements from titles.

### End-of-day checkpoint - October 22

The user ended the session after completing the main Day 1 practical tests,
reporting cleanup with empty ownership/name-scoped scans, and practising oral
questions. Day 2 has not started. Tomorrow, briefly revisit IMDSv2 tokens versus
IAM permissions and the nofail/filesystem-UUID recovery mechanism, one question
at a time, then begin Day 2 in portal order. Review its actual instructions before
setting a completion target. Six course labs remain before the October 28 audit;
adjust the remaining study schedule to actual progress and preserve Tuesday
review time where possible. Video completion and the budget fallback remain
unconfirmed. Today's report is prepared for submission with approximately eight
working hours estimated by the user, excluding breaks; no external submission
was performed.

No cloud execution or deletion by the assistant is authorized by this planning
update. Continue guided, user-performed course steps; do not apply EKS Terraform.

## Prior learning checkpoint - October 21, 2026

- Required execution order, confirmed by the user: both the main AWS/EKS project
  and course labs are console-first. The mentor explicitly requested this for
  the main project; the user has read console-oriented course lab instructions.
  Complete the applicable console build before its IaC implementation. Existing
  Terraform remains a reference; a successful plan does not bypass that phase.
  Keep account/evidence/cleanup scopes separate; exact instructions have not
  been reviewed by the assistant. See the [lab plan](aws-lab-plan.md).
- Day 1 slides and quizzes: completed, as reported by the user on October 21.
  The supplied quiz screenshot shows a best score of 30/34 (88%), passed.
  Videos and course hands-on labs are not recorded as completed.
- No new major assignment has been released. Existing AWS exercises remain
  supplementary, and the prepared EKS foundation is a reference for learning.
- On October 20 the user raised a gap between configuration progress and
  independent understanding. Teach transferable AWS concepts before adding
  project details. Passing a plan or answering a leading question is not mastery.
- The Day 1 outline and selected slides have been reviewed, not the full deck.
  Discussions covered infrastructure scope, root-only tasks, IAM conditions and
  policy types, MFA, access tools, user data/IMDSv2, remote shells, RI matching,
  tenancy, Spot suitability, IP/EIP, placement groups, ENIs/VPC CNI, snapshots,
  custom AMIs and shared EFS access. Discussion is not proof of mastery.
- The user wants a short application of the concepts to the existing project.
  Begin with configuration reading and failure scenarios; no cloud apply is
  authorized. The multi-part course labs appear to use a shared account, per
  the user, but their actual instructions/account scope have not been reviewed.

## Day 1 map from the supplied outline

| Slides | General learning focus | Connection to the current project |
| --- | --- | --- |
| 2-7: Global Infrastructure | Scope, placement, failure boundaries and shared responsibility | Account/Region guard in `main.tf`; AZ/subnet choices in `network.tf`; AWS-managed control plane versus our workers |
| 8-19: IAM | Identify the caller, distinguish trust from permissions, interpret policy evaluation | Human access record; service/worker roles in `iam.tf`, CNI role in `addons.tf`; keep IAM separate from Kubernetes access |
| 20-30: EC2 Basics | Explain a standalone server: image, boot setup, instance sizing, connectivity and administration | AMI pins in `versions.tf`, launch template/node group in `workers.tf`, rules in `security.tf`; learn EC2 itself before the EKS connection |
| 31-38: EC2 Purchasing | Compare purchasing choices against workload duration, flexibility and interruption tolerance | Current node group selects on-demand capacity; other purchasing options are comparison topics, not purchases to make |
| 39-44: EC2 Advanced | Understand address/interface choices and when placement or lifecycle features help | Private worker addresses, NAT EIP and CNI interface management; placement groups/hibernation have no current implementation requirement |
| 45-58: Storage for EC2 | Choose storage using persistence, sharing, location, performance and recovery needs | Root EBS is configured; runner data EBS and archive EFS remain proposed. No CSI data volumes, EFS or snapshots have been provisioned |
| 59-60: Case study and recap | Explain and justify a complete small architecture | Compare the course example with the tournament architecture once the actual case-study slides are supplied |

These links are alignment points, not evidence that the course covers EKS or
Terraform in depth. Study the listed AWS topics even when the app does not
currently use them. Existing configuration was read for this mapping; historical
validation results remain dated October 19, not rerun as part of this update.

## Efficient session loop

1. Read a chapter in the course. Send 1-3 relevant screenshots or a short copied
   excerpt when a diagram, term or decision is unclear; include slide numbers.
   No need to send every slide or recreate the course outside its platform.
2. If convenient, add a sentence beginning "My understanding is..." and the
   question. An incomplete explanation is useful; it is not a prerequisite for help.
3. Explain the general problem and mechanism with a small standalone example.
   Address failure, security and cost where relevant. Verify changing technical
   details with official documentation and the relevant AWS skills.
4. Connect the concept to one existing Terraform block or project decision,
   clearly identifying what is configured, proposed or still unimplemented.
5. At chapter boundaries, use a short explanation, comparison or failure
   prediction in the user's words. Avoid a yes/no quiz after every slide.
   Revisit the unclear connection rather than repeating an entire chapter.

Match depth to the day's target: spend explanation time on gaps in IAM and EC2
fundamentals, while using familiar material as brief retrieval practice. The
target does not imply that all topics must be mastered today. Keep an explicit
review list when a concept needs another pass.

## Course hands-on labs - October 22 account clarification

The user checked access arrangements: no group account is available, so the
course lab will use the user's existing AWS setup. This supersedes the supplied
page's shared-account assumption. Use `metronome-lab` in the existing account,
with Singapore as specified by the lab; verify the signed-in identity before
changes. No new human IAM user or access key is needed for this adaptation.
Further user clarification: this existing account is shared with one other user,
and they have no ownership naming/tagging convention yet. It is not a
single-user account. Introduce distinct Owner values and name prefixes for new
resources; do not relabel, modify or clean up the other user's resources. Agree
ownership/use of any shared infrastructure before changes. Naming/tagging alone
does not enforce access isolation or split the underlying account bill.

The screenshot's setup section assumes a mentor-prepared EC2 role and instance
profile named `atl-lab-ec2-role`, plus network and permission prerequisites.
Check whether these exist; do not treat them as already provisioned. Prepare
missing prerequisites deliberately through guided console steps. Existing
administrator access does not reproduce the course's restricted intern identity
or demonstrate least privilege. Preserve naming/Owner/Project tags and cleanup
boundaries so course resources stay distinct from the main EKS project.

The supplied course page includes console and CloudShell/AWS CLI instructions;
it is not exclusively click-through. Follow those explicit course steps while
retaining the mentor's console-first requirement for the main project and the
required manual phase before IaC. The setup and opening steps were inspected,
not every command in the full-page screenshot.

Setup checkpoint: the user created `atl-lab-ec2-role` through the console on
October 22. Their screenshot shows the role and same-name instance profile in
account `206690614118`, one attached AWS managed policy
`AmazonSSMManagedInstanceCore`, and two tags (values not shown). The trust policy
is not visible in this screenshot and has not been independently checked.
The user's subsequent CloudShell output confirms Region `ap-southeast-1`,
account `206690614118`, caller `user/metronome-lab`, and the same-name profile
containing this role. AZ output shows regular Singapore zones a/b/c plus
`ap-southeast-1-han-1a`; AWS identifies the latter as the Hanoi Local Zone.
Use regular Singapore AZs for this lab. These are user-run read-only results,
not independently executed API checks. At that checkpoint, trust-policy and
network checks remained pending. The next proposed step was `~/atl.env`, using an explicit
lowercase portal username rather than deriving `metronome-lab` from the AWS ARN.
The user then created and sourced `~/atl.env`; their output confirms
`ME=huytq188` and `ACC=206690614118`. Region and tag variables were saved using
the lab's format. The next section is the monthly budget; check Owner cost
allocation tag availability/activation rather than assuming mentor setup.
The user's Billing screenshot shows three inactive keys (`aws:createdBy`,
`lambda-console:blueprint`, `Name`) and no `Owner`. The assistant's initial
account-wide-budget recommendation assumed a single-user account and is
withdrawn as a substitute for the personal lab budget. A named budget's scope,
not its creator/name, determines whose resource costs it includes. Retain the
lab's intended $5 monthly budget filtered by Owner=huytq188, with an actual-cost
80% email alert. This remains pending until the cost allocation tag is usable;
it is not a completed requirement. An account-wide email alert, if coordinated
as a shared monitor, is separate and includes both users' costs. Continue
applying the lab's tags to owned resources and revisit Owner activation after
billing discovers the key. Untagged/shared charges are not automatically
attributed to individual users. Budget creation has not been confirmed.
The next screenshot section has now been read: the course explicitly provides
a fallback when Owner filtering is unavailable: inspect Cost Explorer grouped
by Service over the last seven days if accessible, and establish the existing
account budget/alert recipients with the mentor/account users. These checks
remain pending; do not record an established cost guardrail before verification.
Meanwhile, continue the non-provisioning on-call policy exercise: save a JSON
document allowing EC2 Describe actions, conditionally allowing start/stop/reboot
for Project=atlantic-shop, and explicitly denying termination. The exercise says
not to attach it anywhere. JSON validation, Access Analyzer typo/fix validation
and custom-policy simulation follow. The user subsequently saved
`~/oncall-policy.json`, received `valid JSON` from Python, and ran Access
Analyzer validation with no displayed findings or error. Record this as the
initial validation only; the deliberate typo/fix and policy simulation remain
pending. The document is not attached to an IAM identity, and these checks do
not establish runtime permissions or comprehensive least privilege.
The user attempted `sim atlantic-shop` and `sim payroll`; both returned
`InvalidInput: Policy input list item 1 has invalid content`. No permission
decisions were obtained. Inspect the actual saved policy and rerun validation
before diagnosing content versus argument handling; do not attribute this to
nonexistent resources. The user also needs the distinction between supplied
simulation context and a live EC2 operation explained before more commands.
The user then pasted the saved policy, confirming the corrected StopInstances
action. Retrying a single StopInstances/Project=atlantic-shop test with
`--policy-input-list "$(cat ~/oncall-policy.json)"` succeeded and returned
`allowed`, without changing the policy. Use the working direct-text form for
subsequent simulations. The original file-input form failed in this session;
do not generalize that file:// never works or claim the CLI internal cause was
proven. Describe/Terminate cases and the payroll condition remain unverified.
Subsequent user output for the three-action payroll simulation returned
DescribeInstances=implicitDeny (unexpected), StopInstances=implicitDeny and
TerminateInstances=explicitDeny. The last two match the policy prediction; the
Describe result needs investigation. AWS documents that DescribeInstances does
not support resource-level permissions, so the next diagnostic tests Describe
separately with resource `*` and full JSON output. Do not claim that resource
scope is the proven cause before that result is available. The earlier combined
test's expected Describe result was not validated and needs correction.
The user's separate DescribeInstances test with resource `*`, the same payroll
context and unchanged policy returned `allowed`, matched PolicyInputList.1
lines 3-9 (ViewEc2), and reported no missing context values. This supports the
test-scope correction: simulate Describe separately at `*`; use the instance
ARN for Stop/Terminate. Do not change the policy to compensate for the earlier
mixed-scope test. The user identified the instance-ARN argument as the mismatch.
The user's subsequent atlantic-shop test returned StopInstances=allowed and
TerminateInstances=explicitDeny. A further standalone Describe test at `*`
returned allowed. The document remains unattached; no EC2 operation occurred.

Explanation correction: the user correctly challenged the claim that policy
Resource=`*` would fail to match an instance ARN. Wildcard matching and an
action's support for resource-level permissions are different matters. AWS
documents that DescribeInstances requires Resource=`*` in a policy, but this
does not alone prove why the original simulator returned implicitDeny when
given an instance ARN. The assistant's earlier definitive causal explanation
was unsupported. Treat the successful `*` test as a confirmed read-permission
case, not proof of that diagnosis. Inspect the original instance-ARN Describe
test's full JSON (including matched statements, per-resource decisions and
missing context) to investigate; do not change a validated policy or teach
that Resource=`*` only matches simulator resource=`*`.
The full standalone instance-ARN Describe result reproduced implicitDeny with
MatchedStatements=[], MissingContextValues=[], empty EvalDecisionDetails and
per-resource implicitDeny. This rules out the earlier multi-action table hiding
an allowed result or a reported missing condition key. It still does not explain
the evaluator's internal reason. Official sources reviewed establish wildcard
matching, supported resource types and simulator/live differences, but no
specific documented limitation was found for this exact case. Next bounded
diagnostic: supply only the unchanged ViewEc2 statement inline, retaining
Describe* and the same instance ARN, to isolate effects of the other statements,
the tag context and file loading. Do not present that test as already performed.
The user ran that minimal ViewEc2-only policy and reproduced the denial, then
replaced Describe* with the exact DescribeInstances action and reproduced it
again. Both responses had no matched statements, no missing context and an
instance-specific implicitDeny. Thus the behavior does not require the other
statements, tag context, file loading or an action wildcard. The original
Describe test at `*` remains confirmed allowed. This points to the simulator's
handling of an unsupported action/resource combination, but its internal
reason is an inference, not a documented or proven root cause. Preserve the
reproduction as a follow-up; do not keep repeating equivalent simulations.
Teach the distinction: wildcard resource matching does not create support for
instance-level authorization in an action that lacks it. Use the service-level
`*` test for the course's Describe permission; the policy itself stays unchanged.
The user requested further investigation and reposted the old sim() function,
which still uses file:// on the plain policy object. A local anonymous AWS CLI
2.37.12 serialization diagnostic isolated this input failure: with plain-object
file://, PolicyInputList.member.1 was `{`, member.2 was a quote, and subsequent
members were individual characters. Direct policy text and file:// pointing to
a JSON array of policy strings each serialized one complete policy member.
This explains the InvalidInput item's malformed content in the reproduced CLI
case, consistent with the user's failure; their CloudShell CLI version has not
been checked. The diagnostic used empty config/credential files, unsigned
requests and a loopback-only dummy endpoint; no AWS service was contacted.
Captured only synthetic policy parameters, not credentials. Evidence is outside
Git in the task visualization workspace, iam-cli-capture-c7257d39/
serialization-results.json. Correct the old function's policy-input-list to
the already working quoted file-content form. This is distinct from the
Describe/instance-ARN implicitDeny, whose internal cause remains unconfirmed.
The user explicitly asked to keep investigating rather than leave the failure.
An assistant-run read-only identity attempt using the existing metronome-lab
CLI profile first hit the network sandbox; the approved outside-sandbox retry
reported an expired session. No login, credential creation or IAM write was
performed. Browser inventory exposed no AWS/CloudShell tab, so direct live
execution was unavailable. A standalone diagnostic artifact was prepared in
the visualization workspace, diagnose-iam-simulator.py. It verifies account
identity and makes only IAM simulation calls with synthetic policies/resources,
using structured CLI input to bypass the earlier list-file parsing issue. Six
cases compare global/instance Describe, a universal-Allow control, a deliberately
instance-scoped Describe policy, Stop and S3 GetObject controls. All six CLI
request-shape self-checks passed locally without credentials or AWS requests;
The user then ran the diagnostic in CloudShell: describe_global allowed;
describe_instance, universal_allow_describe_instance and
describe_instance_scoped_policy implicitDeny; stop_instance_control and
get_object_control allowed. The user-held full report is
/home/cloudshell-user/iam-simulator-report-aa4bc362.json; only its six summary
results have been supplied, not the full report or its CLI version.
These controls isolate the observed denial to Describe with an instance target,
not a general wildcard-matching failure. AWS documents that DescribeInstances
does not support resource-level permissions, whereas Start/Stop do. The supported
practical correction is to simulate Describe against `*`, separately from
Stop/Terminate against the instance ARN with the hypothetical Project context.
This interpretation combines observed results with documented action/resource
support; it does not establish the simulator's internal evaluation order.
The user then ran the corrected two-call helper for both hypothetical tags.
Describe allowed in both runs; Stop allowed for atlantic-shop and implicitly
denied for payroll; Terminate explicitly denied in both. All six intended
decisions are now verified from supplied output. The IAM simulation step is
complete, with the policy unchanged and unattached. Here `*` describes the
action's non-resource-scoped authorization, not a globally scoped AWS service.
This is course setup, not an EKS deployment or a completed course lab.

The user subsequently confirmed the Part 1 step 5 IAM inspection was already
done and requested Part 2. Accept that as user-reported completion; no additional
password-policy values or report contents were supplied. Next is Part 2 step 1:
identify the existing default VPC and subnets in two regular Singapore AZs,
record their IDs, then prepare the owned web security group. The user's CloudShell
output now confirms VPC vpc-0e7a62f5eb2757377 and saved selections:
SUBNET_A=subnet-05629cd027c83bcda in ap-southeast-1a;
SUBNET_B=subnet-065a5430efa1f9622 in ap-southeast-1b. Both show
MapPublicIpOnLaunch=True, as does the listed third subnet in zone 1c. The user
appended VPC/SUBNET_A/SUBNET_B to atl.env and sourced it successfully. This
confirms subnet discovery and variable persistence, not route-table verification
or any new cloud resource. Next: console creation of atl-huytq188-web-sg in that
VPC, inbound HTTP TCP 80 from 0.0.0.0/0, no SSH rule, default outbound retained,
Owner=huytq188 and Project=intern-lab. The user then supplied screenshots of
atl-huytq188-web-sg, ID sg-0b16b27e7ae1de94c, in the expected default VPC.
One inbound rule is visible: HTTP/TCP 80 from 0.0.0.0/0. One outbound rule is
visible as IPv4/all traffic/all ports; its destination column is outside the
crop. Tags and SG_WEB persistence are not shown. Creation is confirmed; this
does not prove the unseen tag values or outbound destination.
Inspected course Part 2 steps 3-6 from additional screenshot crops: step 3
writes web-userdata.sh, installing httpd and an atl-page systemd oneshot service
that reads IMDSv2 metadata to rebuild index.html each boot. Step 4 launches
Amazon Linux 2023 x86_64/t3.micro in subnet A, the owned web SG, existing EC2
instance profile, IMDSv2 required and no key pair; user data is pasted into the
console and Owner/Project tags apply to Instances and Volumes. Steps 5/6 check
HTTP and Session Manager. Next is script preparation/syntax validation, not
immediate launch. The user supplied the complete web-userdata.sh creation block
and a successful `bash -n` result, `syntax OK`. Script preparation and outer
shell syntax are confirmed; execution on EC2, package installation, page
generation and Session Manager remain unverified. Next is the course console
launch with the settings above. The user's subsequent console screenshot
confirms atl-huytq188-web-1, instance i-0497a166bbd0b825a, Running, t3.micro,
in subnet-05629cd027c83bcda and VPC vpc-0e7a62f5eb2757377. It shows IAM role
atl-lab-ec2-role, IMDSv2 Required, private IPv4 172.31.38.252 and auto-assigned
public IPv4 18.143.138.231, with no Elastic IP. These addresses are a launch-time
observation, not a promise that the public address survives stop/start. Health
checks, effective security groups, tags, root-volume settings, user-data
execution, HTTP response and Session Manager connection are not shown. Next is
saving IID1, checking status, requesting the web page and connecting through
the console Session Manager tab.
The user then saved/sourced IID1 and supplied a successful CloudShell HTTP
response containing Atlantic Shop, the correct instance ID, ap-southeast-1a
and AMI ami-03d3019940b16a1b2. Their instance session returned ssm-user;
systemctl is-active returned active for both httpd and atl-page; the cloud-init
log ends with package installation Complete, service enablement and cloud-init
finished at 2026-10-22 07:28:32 UTC. HTTP access, a working Session Manager
session and successful bootstrap are now confirmed by supplied output. The
page's populated metadata is consistent with the installed script's token-based
reads. Explicit tokenless IMDS rejection and the course role-name metadata
listing are not yet supplied. EC2 status-check output and the previously unseen
tags/storage settings remain unconfirmed; do not infer those from HTTP alone.
The user then supplied 401 for the deliberate tokenless request to
169.254.169.254/latest/meta-data/ from the instance session, confirming tokenless
IMDS rejection. The separate role-name metadata listing remains unreported.
Inspected Part 3 steps 1-6 from course screenshot crops. Next: create a new
encrypted 10 GiB gp3 data volume in ap-southeast-1a, tagged
Name=atl-huytq188-data, Owner=huytq188, Project=intern-lab; attach only to web-1
at requested device /dev/sdf; save VOL; verify encryption and DeleteOnTermination.
Before formatting, inspect lsblk with volume serial and filesystem/mount data.
Do not assume the course's hard-coded /dev/nvme1n1 is the new disk: match the
new volume ID/serial, size and lack of filesystem/mountpoint. The course then
formats XFS, mounts /data, persists by UUID with nofail, writes sample order
data, snapshots it, creates a root-only AMI and launches web-2 in zone 1b, then
restores the data snapshot into that zone. None of these Part 3 resources or
filesystem operations has been confirmed yet.
The user next supplied a console screenshot confirming new volume
vol-01dbb8e85676df846, Name atl-huytq188-data, 10 GiB gp3, In-use in
ap-southeast-1a and attached to i-0497a166bbd0b825a. Encryption and the attachment's
DeleteOnTermination are not visible. No filesystem work is confirmed.
Their interactive read/append/source sequence failed: source atl.env reported
invalid export identifiers including command words and the describe-volumes
query. This suggests pasted command text entered an export value, but the exact
file contents have not been inspected. Avoid more sourcing of the damaged file
or interactive read prompts in pasted multi-command blocks. Proposed repair:
preserve a timestamped backup, reconstruct the known lab variables in a quoted
heredoc using the confirmed IDs, then source and run volume verification. This
repair is proposed, not yet user-executed. Never format a disk before matching
the confirmed volume ID with the instance's lsblk serial and mount information.
The user supplied lsblk: nvme0n1 is the 8 GiB root disk (serial
vol03063390d289c5422, XFS partition mounted at / and EFI partition at /boot/efi);
nvme1n1 is 10 GiB, serial vol01dbb8e85676df846, with blank FSTYPE/MOUNTPOINTS.
This positively identifies /dev/nvme1n1 as the new data volume. Next guidance
can format that specific blank device as XFS, mount at /data, back up fstab,
persist its UUID with defaults,nofail, test mount -a and write the course sample
order file. These operations remain proposed until user output confirms them.
The atl.env repair and AWS encryption/deletion checks still have no supplied
results; the disk listing alone does not establish those properties.
The user then supplied successful mkfs.xfs, mount and fstab/remount output.
/dev/nvme1n1 is XFS mounted on /data, df reports 10G, and the added entry is
UUID=8200a9f5-f240-4696-bc3b-a665c27252ac /data xfs defaults,nofail 0 2.
A timestamped fstab backup command was included. The mountpoint-guarded sample
write, sync and cat completed, yielding Order 11.11 - first backup in
/data/orders-1111.txt. Formatting, mounting, the mount-a test and sample data
are confirmed; an actual reboot persistence test has not been performed.
Next is checking the still-unreported volume encryption/deletion properties
using the explicit known ID (avoiding dependency on atl.env repair), then the
course console snapshot of this data volume only, named
atl-huytq188-data-snap1 with Owner/Project tags. No snapshot creation or restore
is confirmed yet.
The user then supplied describe-volumes output for vol-01dbb8e85676df846:
Encrypted=True and DeleteOnTermination=False. Their console screenshot confirms
snapshot snap-089dcc7537f0706bf, Name atl-huytq188-data-snap1, Completed/100%,
source volume size 10 GiB and description Atlantic Shop sample order backup.
Snapshot creation/completion is confirmed; restore verification remains pending.
Next is course Part 3 step 4: create atl-huytq188-web-v1 from web-1 through the
console, keep default reboot for consistency, exclude the 10 GiB /dev/sdf data
volume from the image mapping, retain only the 8 GiB root volume, and tag image
and snapshots together with Owner/Project. Excluding the data volume from the
image configuration does not detach/delete the original volume. A successful
AMI must become Available and its mapping must show only the root snapshot.
AMI creation is not yet confirmed. Keep explicit-ID commands independent of
the still-unverified atl.env repair; avoid another interactive read prompt.
The user's next screenshot confirms AMI ami-0f155e4e78b8d6537, named
atl-huytq188-web-v1, Available, private visibility, EBS root device /dev/xvda,
x86_64 and owner 206690614118. Storage mapping is not visible, so root-only
exclusion of the data volume still needs verification in the Storage tab or
describe-images. Next is Part 3 step 5: launch one atl-huytq188-web-2 from this
AMI in subnet-065a5430efa1f9622 (zone 1b), t3.micro, same owned web SG, public
IPv4 enabled, existing EC2 role/profile, IMDSv2 required, no key pair and empty
user data. Apply Owner/Project tags to instance and volume. No second instance
or AMI-based HTTP success has been confirmed yet.
The user supplied a web-2 console screenshot: i-043760db9d6cca6b2, Running,
t3.micro, subnet-065a5430efa1f9622 (previously verified zone 1b), public IPv4
3.1.194.64, private IPv4 172.31.26.73, expected VPC, IMDSv2 Required. The IAM
role field says No roles attached to instance profile: atl-lab-ec2-role.
Do not assume the role association is healthy or modify the shared profile
based on the console message alone. Next are read-only CloudShell tests:
request the new server's HTTP page, get-instance-profile Roles[].RoleName and
describe the instance's AMI/AZ/block-device mapping. These also close the
unseen AMI root-only mapping before a restored disk is attached. The second
instance launch is confirmed; HTTP, Session Manager and actual profile contents
remain pending. No automatic cloud changes have been made by the assistant.
The user then supplied successful HTTP from web-2 showing its own instance ID,
zone ap-southeast-1b and custom AMI ami-0f155e4e78b8d6537. IAM get-instance-profile
returned [atl-lab-ec2-role]; do not treat the earlier console message as a
confirmed empty profile or change IAM based on it. describe-instances confirms
the custom AMI, zone 1b and only /dev/xvda in the running clone's device mapping.
The AMI-based page and root-only clone are now verified. Empty launch user data
was instructed but not independently retrieved. Web-2 Session Manager remains
unconfirmed until the next connection.
Next is course Part 3 step 6, adapted to console creation: select data snapshot
snap-089dcc7537f0706bf, create a 10 GiB gp3 volume in ap-southeast-1b with
Name=atl-huytq188-data-copy, Owner=huytq188 and Project=intern-lab; encryption
is inherited from the encrypted snapshot. Attach to web-2 as /dev/sdf. This is
a separate new volume; leave the original zone-1a data volume in place. On
web-2, inspect filesystem/serial/UUID, confirm the existing fstab line inherited
from the AMI, then mount -a and read orders-1111.txt. Never mkfs the restored
volume; its existing XFS/data are the point of the restore test. The course
expects the restored filesystem UUID to match the original fstab entry. No
restored volume or recovered file is confirmed yet.
The user next supplied web-2 disk and mount output. New restored volume
vol-01adf594a87c1556a is /dev/nvme1n1, 10 GiB XFS, UUID
8200a9f5-f240-4696-bc3b-a665c27252ac, matching both the original filesystem and
the inherited fstab entry. mount -a and findmnt show /data mounted successfully;
cat returns Order 11.11 - first backup. Web-2's root serial is
vol0f38cab5e27d29ae6. This verifies the sample-data snapshot restore across AZs
and the user-run web-2 shell, not a scheduled/application-wide backup system.
Part 3 core outcomes are complete. No format was run on the restored volume.
Next is Part 4 step 1: create atl-huytq188-efs-sg in the existing default VPC,
one inbound NFS/TCP 2049 rule sourced from web SG sg-0b16b27e7ae1de94c, retained
default outbound and Owner/Project tags. Attach that SG to EFS mount targets
when creating the file system, not to the web instances. No EFS SG, filesystem,
mount targets or shared file test is confirmed yet.
The user supplied the creation-success screenshot for atl-huytq188-efs-sg,
ID sg-036f6972e35942ee7, expected default VPC, one inbound NFS/TCP 2049 rule
referencing the web SG, and one outbound rule. Earlier pre-creation screenshot
showed an invalid outbound TCP/0 row with no destination; guidance corrected
it to the course's default all-traffic/Anywhere-IPv4 rule. The success screenshot
does not display the final outbound destination or tag values. Next is Part 4
step 2: console Customize EFS creation, Name atl-huytq188-efs, Regional,
encrypted, General Purpose/Elastic, automatic backups disabled for this
temporary course exercise, lifecycle IA after 30 days, Archive after 90 days,
Standard on first access. Apply Owner/Project tags, keep only mount targets in
subnets 1a/1b with the new EFS SG replacing the default SG, and skip optional
file-system policy as in the course. Later mounts should use TLS. No EFS
filesystem or mount-target creation has been confirmed yet.
The user then supplied the EFS general-details screenshot confirming
fs-05a177961a88c0df7 (atl-huytq188-efs), Available, Regional, encrypted with
aws/elasticfilesystem, General Purpose, Elastic throughput, automatic backups
disabled and lifecycle IA=30 days, Archive=90 days, Standard=on first access.
Mount targets and their SGs are not visible. Next: save FS, read mount targets
and confirm two Available targets in 1a/1b; install amazon-efs-utils and mount
this same ID with -t efs -o tls at /mnt/shared in each server's own Session
Manager shell. No EFS mount or cross-server file sharing has been verified yet.
Inspected the remaining course Part 4 steps: step 3 mounts both with TLS and
checks df -hT; step 4 writes hello.txt on web-1, reads/appends on web-2 and reads
back on web-1, plus writes /data/after-snapshot.txt on web-1 and shows it is
absent from web-2's separately restored data disk. Optional challenges change
gp3 performance and make an encrypted root-snapshot copy; these are optional,
not already authorized cloud operations or completed exercises. Course cleanup
begins after required checks; do not execute its deletion loops against a
shared account without a concrete owned-resource inventory and user authority.
The user supplied mount-target output: zone 1a Available at 172.31.40.236 and
zone 1b Available at 172.31.20.124. They supplied the two per-server install and
mount transcripts: amazon-efs-utils 3.3.3-1.amzn2023 installed, mount -t efs
-o tls fs-05a177961a88c0df7:/ /mnt/shared completed, and df -hT reports
127.0.0.1:/ type nfs4 at /mnt/shared on both. These confirm the requested TLS
mounts and two available targets. The loopback source is consistent with the
local TLS helper/proxy; the displayed 8.0E capacity is not preallocated billable
storage. Actual usage is metered separately by EFS. Next is Part 4 step 4's
ordered cross-server hello.txt write/read/append test and after-snapshot.txt
comparison between the two independent /data disks. No shared-file test or
post-snapshot comparison result is confirmed yet. Required exercise evidence,
ownership-scoped cleanup review and unresolved budget/env notes remain before
declaring the whole Day 1 lab closed.
The user supplied the final comparison outputs: web-1 wrote the EFS message
with hostname ip-172-31-38-252.ap-southeast-1.compute.internal and the later
/data/after-snapshot.txt. Web-2 read the shared message and appended its line;
web-1's final cat shows both messages. Web-2's /data listing shows only
orders-1111.txt. This verifies live bidirectional EFS sharing and the independent
point-in-time EBS restore, completing the main practical tests in Parts 1-4.
Do not equate this with completed cleanup, confirmed videos, budget fallback
resolution, an actual reboot test, SME approval or proven independent mastery.
Optional challenges have not been run and can wait under the agreed schedule.
Next prepare an exact owned-resource cleanup inventory: the two instances and
all their volume deletion flags, the custom AMI's root snapshot ID, and the
known EFS filesystem's mount-target IDs. No cleanup has been authorized or
executed yet. Preserve recorded evidence first. Console EFS deletion handles
its targets, but unmount clients first; terminate only the two identified
instances; remove only their retained lab volumes, custom AMI and associated
root snapshot plus the data snapshot; delete EFS SG before web SG. Keep the
default VPC/subnets, role/profile and account-level billing settings outside
this proposed cleanup. Obtain explicit authority for the concrete destructive
scope after the read-only inventory, following repository instructions.

### Verified Day 1 cleanup scope - user reports completed

The user reran the inventory with AWS_PAGER empty. These are confirmed user-run
API results recorded before cleanup. The table describes the reviewed scope;
the user later reports completion, as qualified below.

| Resource | Exact scope | Planned handling |
| --- | --- | --- |
| web-1 | i-0497a166bbd0b825a | Terminate through console |
| web-2 | i-043760db9d6cca6b2 | Terminate through console |
| web-1 root EBS | vol-03063390d289c5422 | DeleteOnTermination=True; verify automatic deletion |
| web-2 root EBS | vol-0f38cab5e27d29ae6 | DeleteOnTermination=True; verify automatic deletion |
| Original data EBS | vol-01dbb8e85676df846 | DeleteOnTermination=False; explicitly delete after detach/termination |
| Restored data EBS | vol-01adf594a87c1556a | DeleteOnTermination=False; explicitly delete after detach/termination |
| EFS filesystem | fs-05a177961a88c0df7 | Unmount both clients, delete own filesystem through console |
| EFS target 1a | fsmt-0e1f662b3addb5b61 | Removed with filesystem console workflow; verify disappearance |
| EFS target 1b | fsmt-07255946d54183142 | Removed with filesystem console workflow; verify disappearance |
| Custom AMI | ami-0f155e4e78b8d6537 | Deregister after preserving evidence |
| AMI root snapshot | snap-0b60b52960df19252 | Delete with AMI console option or separately after deregistration |
| Data snapshot | snap-089dcc7537f0706bf | Explicitly delete |
| EFS SG | sg-036f6972e35942ee7 | Delete after EFS target ENIs are gone, before web SG |
| Web SG | sg-0b16b27e7ae1de94c | Delete after own instance ENIs and EFS SG reference are gone |

This scope permanently removes the temporary sample order files and shared
hello.txt, plus their lab recovery copies. The supplied results are recorded in
these learning notes and the draft daily report. The original Amazon Linux AMI,
default VPC/subnets, atl-lab-ec2-role/profile, billing settings, CloudShell
learning files and the other user's resources are outside the proposed cleanup.
Obtain one explicit authorization covering this complete scope before guiding
the destructive sequence; do not create an approval loop for each resource.
Console deletion dependency handling was verified against official EFS and EC2
documentation. After authorization, guide user-performed console cleanup and
use exact-ID read-only checks for leftovers. No broad tag-based deletion loops.
The user subsequently stated they were finished and supplied six successful
empty cleanup scans after source ~/atl.env returned without errors: no
Owner=$ME instances in pending/running/stopping/stopped states, volumes,
snapshots or owned AMIs; no security groups named atl-$ME-*; no EFS filesystem
named atl-$ME-efs. Record cleanup as user-reported complete with clean scoped
verification. The deletion operations themselves were not supplied or executed
by the assistant. These scans depend on the expected variable/tag/name values,
exclude shutting-down/terminated instances, and do not independently prove
absence of every exact ID or untagged leftover. Do not claim the entire shared
account is empty or costs have fully settled. No additional destructive action
is requested or needed on this evidence. The new successful source call confirms
the previously failing environment file now loads without reported export
errors; its exact retained variables/contents were not supplied.
Next: a brief user explanation of the AMI/fstab/nofail/UUID restore behavior
before Day 2, preserving the practical results without claiming independent
mastery. Videos, budget fallback and quiz-typo demonstration remain separately
unconfirmed. Daily hours remain pending until the end-of-session report.
The user's first explanation identified the golden AMI containing the software
needed to run and avoiding installation at each launch. They did not yet name
nofail or the preserved filesystem UUID. Clarify that the copied fstab entry's
nofail permits boot with the data disk absent, while the separately restored
snapshot preserves the filesystem UUID expected by that entry; the EBS volume
ID itself changes. AMI software readiness is distinct from optional-mount boot
behavior. Startup time was not benchmarked, so do not claim a measured speedup.
Revisit nofail/UUID in later retrieval practice without requiring another
immediate per-line quiz before moving to the Day 2 portal material.
The user then explicitly requested more Day 1/lab audit questions and specified
one question at a time. Continue this review before switching modules; do not
send another batch or impose the earlier move-to-Day-2 suggestion. They correctly
classified all seven Region/AZ resources, distinguished role trust from
permissions, identified the instance profile as a role container, rejected
inheritance of the launching user's admin permissions, and explained that an
unattached simulated policy has no real enforcement effect. The profile's EC2
association purpose was supplied as clarification.
For IMDSv2, they recognized 401 as unauthorized and associated successful reads
with a token, but also described it as representing appropriate permission.
Clarify the separation between an instance-local IMDS session token and IAM
role credentials/permissions: the script uses PUT to obtain the metadata token
and includes it in GET headers; ordinary instance-id metadata is not an IAM
API permission grant. A valid metadata token does not itself grant S3 access.
Keep the next follow-up to one conceptual question and mark this distinction
as needing reinforcement rather than fully independently explained.

- Read the actual instructions before deciding whether the existing setup can
  be reused. Identify the intended account/Region, prerequisites and required
  permissions; a screenshot of an outline is not a complete lab specification.
- Explain each change's purpose, impact, cost, verification and cleanup before
  guiding the user through it. The user performs the exercise; do not create
  resources, change IAM, upgrade the account or delete data automatically.
- Prefer the course's small standalone examples for fundamentals. Reuse or
  adapt the EKS project only where doing so helps the lesson. A separate lab
  should not silently import, replace or delete resources from another state.
- Follow the required console-first sequence: finish and verify the applicable
  console lab before its IaC implementation. Existing Terraform may illustrate
  settings, but do not apply it to bypass the exercise. Plan explicit resource
  adoption or clean rebuild for the later phase. Do not expand a small EC2
  exercise into an EKS deployment.

## Checkpoint and daily reporting

- Day 1 slides and quizzes are complete by user report; quiz score is supported
  by the supplied screenshot. Videos remain unconfirmed and course labs remain
  pending. The worker-loss/snapshot, IAM and storage-choice scenarios below were
  discussed with user explanations and corrections; no live lab was performed.
- Record a few concrete takeaways and unresolved questions at chapter/session
  boundaries. Reports use brief English bullets and confirmed hours, following
  the [daily report conventions](daily-reports/README.md).
- Historical EKS bootstrap/IMDS questions remain available in the
  [foundation walkthrough](aws-eks-foundation.md). Return to them when they
  connect to the current course topic rather than forcing the old lesson order.

## Project application after Day 1

Work through these one at a time, with the user explaining their reasoning.
These are supplementary project exercises, not substitutes for course-lab
completion or evidence of successful AWS deployment.

1. Read the worker root-disk and node-group configuration in `workers.tf`.
   Explain the outcome of worker termination/replacement, distinguish root
   storage from proposed runner data, and distinguish recovery from availability.
2. Trace one service role from its trust policy to its permissions, classifying
   the policy as AWS managed, customer managed or inline. Explain why the role
   does not grant the same permissions to the human or every application Pod.
3. Map proposed runner EBS, shared archive EFS and image/root-disk AMI choices
   to persistence, sharing, AZ scope and backup needs. Treat Spot simulator
   placement as a possible later optimization requiring failure/retry testing.

Keep answers and uncertainties for the day's brief English report. October 21
records 7.9 working hours, estimated from the user-reported 9.4-hour total minus
a 1.5-hour lunch break; this is separate from October 19's estimate.

### End-of-day review - October 21

- Worker replacement: the user identified root-volume deletion and replacement
  from an AMI, and snapshot recovery only through the captured point in time.
  Deterministic recomputation still depends on preserved inputs and versions.
- IAM: the user distinguished trust from attached permissions. Clarified that
  role assignment is separate and trust alone supplies no worker permissions.
- Storage: the user identified shared access and EBS AZ constraints. Reinforce
  that runner EBS is durable, EFS is not limited to infrequent access, and both
  require lifecycle protections and backups. Multi-Attach is not an ordinary
  shared-filesystem substitute.
- A bounded repository search found no configured application backup schedule
  or storage-loss restore procedure. Existing state/checkpoints and completed
  archive publication are not verified independent backups. Codebase Memory
  returned `Transport closed`; direct source/configuration reads were used.
  No live AWS backup inventory was performed. Follow-up: DATA-BACKUP-01 in the
  lab plan.
- At this checkpoint, the user expected a live project/understanding audit next week, potentially
  including general AWS and Kubernetes questions. Dates and assessment scope
  remain unconfirmed; prepare explanations and evidence without claiming an
  AWS deployment or course-lab completion. The October 22 agreement above now
  distinguishes the mentor lab review from the SME general knowledge audit.
