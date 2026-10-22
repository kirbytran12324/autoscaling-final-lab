// Conservative boundaries for destroying this foundation, not a future app stack.
export const account = '206690614118';
export const region = 'ap-southeast-1';
export const cluster = 'metronome-lab';
export const profile = 'metronome-terraform';

const addresses = [
  'aws_cloudwatch_log_group.eks', 'aws_cloudwatch_log_group.vpc_flow',
  'aws_eip.nat', 'aws_eks_access_entry.admin', 'aws_eks_access_policy_association.admin',
  ...['eks-pod-identity-agent', 'kube-proxy', 'vpc-cni'].map(n => `aws_eks_addon.before_workers["${n}"]`),
  'aws_eks_addon.coredns', 'aws_eks_cluster.lab', 'aws_eks_node_group.workers', 'aws_flow_log.lab',
  ...['eks_cluster', 'vpc_cni', 'vpc_flow', 'workers'].map(n => `aws_iam_role.${n}`),
  'aws_iam_role_policy.vpc_flow',
  ...['eks_cluster', 'vpc_cni', 'workers_ecr', 'workers_node'].map(n => `aws_iam_role_policy_attachment.${n}`),
  'aws_internet_gateway.lab', 'aws_launch_template.workers', 'aws_nat_gateway.lab',
  ...['private', 'public'].map(n => `aws_route_table.${n}`),
  ...['private_a', 'private_b', 'public_a', 'public_b'].flatMap(n => [
    `aws_route_table_association.${n}`, `aws_subnet.${n}`,
  ]),
  ...['cloudshell', 'efs', 'eks', 'workers'].map(n => `aws_security_group.${n}`),
  'aws_vpc.lab',
  ...['cloudshell_https', 'cloudshell_to_eks', 'eks_to_kubelet', 'eks_to_lb_webhook',
    'workers_https', 'workers_to_efs', 'workers_to_eks', 'workers_to_workers']
    .map(n => `aws_vpc_security_group_egress_rule.${n}`),
  ...['efs_from_workers', 'eks_from_cloudshell', 'eks_from_workers', 'kubelet_from_eks',
    'lb_webhook_from_eks', 'workers_to_workers'].map(n => `aws_vpc_security_group_ingress_rule.${n}`),
  ...['tcp', 'udp'].flatMap(p => [
    `aws_vpc_security_group_egress_rule.eks_to_dns["${p}"]`,
    `aws_vpc_security_group_ingress_rule.dns_from_eks["${p}"]`,
  ]),
];
export const allowedAddresses = new Set(addresses);
export const resources = module => [
  ...(module?.resources ?? []), ...(module?.child_modules ?? []).flatMap(resources),
];
const reject = message => { throw new Error(message); };

export function guardIdentity(identity) {
  if (identity.Account !== account || identity.Arn !== `arn:aws:iam::${account}:user/metronome-lab`) {
    reject('Use the expected metronome-lab IAM identity in the expected account.');
  }
}

export function guardState(state) {
  const managed = resources(state.values?.root_module).filter(r => r.mode === 'managed');
  for (const r of managed) {
    if (!allowedAddresses.has(r.address)) reject(`Unreviewed state resource: ${r.address}`);
    if (r.values?.region && r.values.region !== region) reject(`Unexpected Region: ${r.address}`);
    if (r.values?.arn?.startsWith('arn:aws:')) {
      const owner = r.values.arn.split(':')[4];
      if (owner && owner !== account) reject(`Unexpected resource account: ${r.address}`);
    }
    const tags = r.values?.tags_all ?? r.values?.tags;
    if (tags && (tags.Lab !== cluster || tags.ManagedBy !== 'Terraform')) {
      reject(`Missing ownership tags: ${r.address}`);
    }
  }
  const vpc = managed.find(r => r.address === 'aws_vpc.lab');
  if (vpc && vpc.values.cidr_block !== '10.30.0.0/16') reject('Unexpected VPC CIDR.');
  const eks = managed.find(r => r.address === 'aws_eks_cluster.lab');
  if (eks && eks.values.name !== cluster) reject('Unexpected EKS cluster name.');
  return managed;
}

export function guardDestroyPlan(plan, stateResources) {
  const current = new Set(stateResources.map(r => r.address));
  for (const change of plan.resource_changes ?? []) {
    if (change.mode === 'data') continue;
    const actions = change.change.actions;
    if (actions.length === 1 && actions[0] === 'no-op') continue;
    if (!allowedAddresses.has(change.address) || !current.has(change.address) ||
        actions.length !== 1 || actions[0] !== 'delete') {
      reject(`Unexpected destroy action: ${change.address}: ${actions.join(',')}`);
    }
    const original = stateResources.find(r => r.address === change.address);
    if (original.values.id !== change.change.before.id) reject(`Resource changed during review: ${change.address}`);
  }
}

export function guardKubernetes(items) {
  const systemNamespaces = new Set(['default', 'kube-system', 'kube-public', 'kube-node-lease']);
  for (const item of items) {
    const {kind, metadata: m = {}} = item;
    const ns = m.namespace;
    const name = m.name ?? '';
    let safe = false;
    if (kind === 'Namespace') safe = systemNamespaces.has(name);
    if (kind === 'Service') safe = (ns === 'default' && name === 'kubernetes') || (ns === 'kube-system' && name === 'kube-dns');
    if (kind === 'Deployment') safe = ns === 'kube-system' && name === 'coredns';
    if (kind === 'DaemonSet') safe = ns === 'kube-system' && ['aws-node', 'kube-proxy', 'eks-pod-identity-agent'].includes(name);
    if (kind === 'ReplicaSet') safe = ns === 'kube-system' && m.ownerReferences?.some(o => o.kind === 'Deployment' && o.name === 'coredns');
    if (kind === 'Pod') safe = ns === 'kube-system' && m.ownerReferences?.some(o =>
      (o.kind === 'DaemonSet' && ['aws-node', 'kube-proxy', 'eks-pod-identity-agent'].includes(o.name)) ||
      (o.kind === 'ReplicaSet' && /^coredns-[a-z0-9]+$/.test(o.name)));
    if (!safe) reject(`Non-foundation Kubernetes object: ${kind} ${ns ?? ''}/${name}. Review its cleanup and data first.`);
  }
}

export function guardInterfaces(interfaces, nodeIds, natId) {
  for (const eni of interfaces) {
    const description = eni.Description ?? '';
    const safe = (eni.Attachment?.InstanceId && nodeIds.includes(eni.Attachment.InstanceId)) ||
      description === `Amazon EKS ${cluster}` ||
      (eni.InterfaceType === 'nat_gateway' && description === `Interface for NAT Gateway ${natId}`);
    if (!safe) reject(`Unreviewed VPC interface ${eni.NetworkInterfaceId} (${description}). Remove its owning environment/service first.`);
  }
}
