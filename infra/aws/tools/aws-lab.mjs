#!/usr/bin/env node
// Local lifecycle owner. No cloud writes unless the destroy subcommand and
// account confirmation are both supplied. No shell interpolation or default kubeconfig.
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {account, region, cluster, profile, guardIdentity, guardState, guardDestroyPlan,
  guardKubernetes, guardInterfaces} from './foundation-guards.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export function execute(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: {...process.env, AWS_PROFILE: profile, AWS_REGION: region, AWS_PAGER: ''},
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${binary} failed: ${result.error?.message || result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export function createCommands(run = execute) {
  const tf = (...args) => run(process.env.TERRAFORM_BIN ?? 'terraform', ['-chdir=infra/aws/lab', ...args]);
  const aws = (...args) => JSON.parse(run('aws', [...args, '--profile', profile, '--region', region, '--output', 'json', '--no-cli-pager']));
  return {tf, aws};
}

function kubernetesInventory(aws, run, directory) {
  const kubeconfig = join(directory, 'kubeconfig');
  run('aws', ['eks', 'update-kubeconfig', '--name', cluster, '--region', region,
    '--profile', profile, '--kubeconfig', kubeconfig, '--alias', cluster]);
  const kubectl = (...args) => run('kubectl', ['--kubeconfig', kubeconfig,
    '--context', cluster, '--request-timeout=30s', ...args]);
  const list = JSON.parse(kubectl('get',
    'namespaces,pv,pvc,deployments,statefulsets,daemonsets,replicasets,jobs,cronjobs,pods,services,ingresses',
    '--all-namespaces', '-o', 'json'));
  guardKubernetes(list.items);
  return kubectl;
}

function checkVpc(aws, managed) {
  const vpc = managed.find(r => r.address === 'aws_vpc.lab')?.values.id;
  if (!vpc) return;
  const vpcs = aws('ec2', 'describe-vpcs', '--filters', `Name=vpc-id,Values=${vpc}`).Vpcs;
  if (vpcs.length === 0) return; // Externally removed: Terraform refresh handles it.
  const tags = Object.fromEntries((vpcs[0].Tags ?? []).map(t => [t.Key, t.Value]));
  if (vpcs[0].IsDefault || tags.Lab !== cluster || tags.ManagedBy !== 'Terraform') throw new Error('VPC ownership check failed.');
  if (aws('elbv2', 'describe-load-balancers').LoadBalancers.some(lb => lb.VpcId === vpc) ||
      aws('elb', 'describe-load-balancers').LoadBalancerDescriptions.some(lb => lb.VPCId === vpc)) {
    throw new Error('Load balancers exist in this VPC. Remove through their owning controller first.');
  }
  const instances = aws('ec2', 'describe-instances', '--filters',
    `Name=vpc-id,Values=${vpc}`, `Name=tag:eks:cluster-name,Values=${cluster}`,
    'Name=tag:eks:nodegroup-name,Values=workers').Reservations.flatMap(r => r.Instances);
  const nat = managed.find(r => r.address === 'aws_nat_gateway.lab')?.values.id;
  guardInterfaces(aws('ec2', 'describe-network-interfaces', '--filters',
    `Name=vpc-id,Values=${vpc}`).NetworkInterfaces, instances.map(i => i.InstanceId), nat);
}

export function main(args = process.argv.slice(2), run = execute) {
  const [command, ...flags] = args;
  if (!['check', 'verify', 'destroy'].includes(command)) throw new Error('Usage: node infra/aws/tools/aws-lab.mjs check|verify|destroy [--confirm-account=206690614118]');
  if (flags.some(f => f !== `--confirm-account=${account}`)) throw new Error('Unknown argument.');
  if (command === 'destroy' && !flags.includes(`--confirm-account=${account}`)) throw new Error('Destroy requires explicit --confirm-account=206690614118. This deletes the foundation and its logs.');
  const {tf, aws} = createCommands(run);
  guardIdentity(aws('sts', 'get-caller-identity'));
  if (tf('workspace', 'show').trim() !== 'default') throw new Error('Use the default workspace for this lab state.');
  if (command === 'check') {
    process.stdout.write(tf('fmt', '-check', '-recursive'));
    process.stdout.write(tf('validate', '-no-color'));
    process.stdout.write(tf('test', '-no-color'));
    process.stdout.write(tf('plan', '-input=false', '-lock-timeout=60s', '-no-color'));
    return;
  }
  const state = JSON.parse(tf('show', '-json'));
  const managed = guardState(state);
  if (managed.length === 0) {
    if (command === 'verify') throw new Error('No applied lab resources in this state.');
    console.log('No managed resources in this state. Nothing deleted; this is not an account-wide orphan audit.');
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), 'metronome-lab-'));
  try {
    const live = aws('eks', 'list-clusters').clusters.includes(cluster);
    if (live) {
      const actual = aws('eks', 'describe-cluster', '--name', cluster).cluster;
      const stateCluster = managed.find(r => r.address === 'aws_eks_cluster.lab');
      if (!stateCluster || actual.arn !== stateCluster.values.arn || actual.resourcesVpcConfig.vpcId !== managed.find(r => r.address === 'aws_vpc.lab')?.values.id) throw new Error('Live cluster does not match state.');
      const kubectl = kubernetesInventory(aws, run, directory);
      if (command === 'verify') {
        console.log(kubectl('get', 'nodes', '-o', 'wide'));
        const nodes = JSON.parse(kubectl('get', 'nodes', '-o', 'json')).items;
        if (nodes.length !== 2 || nodes.some(n => !n.status.conditions.some(c => c.type === 'Ready' && c.status === 'True'))) throw new Error('Expected two Ready workers.');
        for (const name of ['aws-node', 'kube-proxy', 'eks-pod-identity-agent']) console.log(kubectl('-n', 'kube-system', 'rollout', 'status', `daemonset/${name}`, '--timeout=120s'));
        console.log(kubectl('-n', 'kube-system', 'rollout', 'status', 'deployment/coredns', '--timeout=120s'));
        for (const name of ['vpc-cni', 'kube-proxy', 'eks-pod-identity-agent', 'coredns']) {
          const addon = aws('eks', 'describe-addon', '--cluster-name', cluster, '--addon-name', name).addon;
          if (addon.status !== 'ACTIVE' || addon.health?.issues?.length) throw new Error(`Unhealthy add-on: ${name}`);
        }
        console.log('Foundation nodes and add-ons passed read-only verification. Packet-level policy tests are still separate.');
        return;
      }
    } else if (command === 'verify') throw new Error('The lab cluster does not exist.');
    checkVpc(aws, managed);
    const planPath = join(directory, 'destroy.tfplan');
    process.stdout.write(tf('plan', '-destroy', '-input=false', '-lock-timeout=60s', '-no-color', `-out=${planPath}`));
    const plan = JSON.parse(tf('show', '-json', planPath));
    guardDestroyPlan(plan, managed);
    // Apply only the reviewed deletion-only plan, never an implicit fresh plan.
    process.stdout.write(tf('apply', '-input=false', '-no-color', planPath));
    if (guardState(JSON.parse(tf('show', '-json'))).length) throw new Error('Managed resources remain in state. Rerun diagnosis before claiming cleanup.');
    if (aws('eks', 'list-clusters').clusters.includes(cluster)) throw new Error('Cluster remains after teardown.');
    const ownership = [`Name=tag:Lab,Values=${cluster}`, 'Name=tag:ManagedBy,Values=Terraform'];
    const leftovers = [
      ...aws('ec2', 'describe-volumes', '--filters', ...ownership).Volumes,
      ...aws('ec2', 'describe-addresses', '--filters', ...ownership).Addresses,
      ...aws('ec2', 'describe-vpcs', '--filters', ...ownership).Vpcs,
      ...aws('ec2', 'describe-nat-gateways', '--filter', ...ownership).NatGateways.filter(n => n.State !== 'deleted'),
    ];
    if (leftovers.length) throw new Error('Tagged VPC/NAT/EIP/EBS resources remain. Review them; they were not force-deleted.');
    console.log('Foundation teardown complete. State retained. Account user, domain, default VPC, and shared AWS service-linked roles are outside scope.');
  } finally {
    // Only the unique directory created above, never a caller-supplied path.
    rmSync(directory, {recursive: true, force: true});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
