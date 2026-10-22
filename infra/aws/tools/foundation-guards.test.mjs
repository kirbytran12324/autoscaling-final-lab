import test from 'node:test';
import assert from 'node:assert/strict';
import {account, cluster, allowedAddresses, guardIdentity, guardState, guardDestroyPlan,
  guardKubernetes, guardInterfaces} from './foundation-guards.mjs';
import {main} from './aws-lab.mjs';

const tags = {Lab: cluster, ManagedBy: 'Terraform'};
const vpc = {address: 'aws_vpc.lab', mode: 'managed', values: {id: 'vpc-owned', cidr_block: '10.30.0.0/16', tags_all: tags}};
const state = rs => ({values: {root_module: {resources: rs}}});
const deletion = (r, actions = ['delete']) => ({address: r.address, mode: 'managed', change: {actions, before: r.values}});

test('identity rejects wrong account, role, and root', () => {
  guardIdentity({Account: account, Arn: `arn:aws:iam::${account}:user/metronome-lab`});
  for (const identity of [
    {Account: '000000000000', Arn: `arn:aws:iam::${account}:user/metronome-lab`},
    {Account: account, Arn: `arn:aws:iam::${account}:root`},
    {Account: account, Arn: `arn:aws:sts::${account}:assumed-role/admin/session`},
  ]) assert.throws(() => guardIdentity(identity));
});

test('state rejects storage, foreign modules, missing tags, foreign ARN, Region and VPC CIDR', () => {
  assert.equal(allowedAddresses.size, 57);
  assert.deepEqual(guardState(state([vpc])), [vpc]);
  for (const resource of [
    {...vpc, address: 'aws_efs_file_system.archive'},
    {...vpc, address: 'module.foreign.aws_vpc.lab'},
    {...vpc, values: {...vpc.values, tags_all: {}}},
    {...vpc, values: {...vpc.values, arn: 'arn:aws:ec2:ap-southeast-1:000000000000:vpc/vpc-owned'}},
    {...vpc, values: {...vpc.values, region: 'eu-west-1'}},
    {...vpc, values: {...vpc.values, cidr_block: '172.31.0.0/16'}},
  ]) assert.throws(() => guardState(state([resource])));
  assert.throws(() => guardState({values: {root_module: {child_modules: [{resources: [{...vpc, address: 'module.foreign.aws_vpc.lab'}]}]}}}));
});

test('reviewed destroy accepts deletes only and rejects replacement or changed IDs', () => {
  guardDestroyPlan({resource_changes: [deletion(vpc)]}, [vpc]);
  for (const change of [deletion(vpc, ['create']), deletion(vpc, ['delete', 'create']),
    deletion({...vpc, values: {...vpc.values, id: 'vpc-other'}}),
    deletion({...vpc, address: 'aws_vpc.foreign'})]) {
    assert.throws(() => guardDestroyPlan({resource_changes: [change]}, [vpc]));
  }
});

test('inventory refuses PVCs, PVs, non-foundation workloads, services, and namespaces', () => {
  guardKubernetes([
    {kind: 'Namespace', metadata: {name: 'kube-system'}},
    {kind: 'DaemonSet', metadata: {namespace: 'kube-system', name: 'aws-node'}},
    {kind: 'Pod', metadata: {namespace: 'kube-system', name: 'coredns-a-b', ownerReferences: [{kind: 'ReplicaSet', name: 'coredns-abcd'}]}},
  ]);
  for (const item of [
    {kind: 'PersistentVolume', metadata: {name: 'evidence'}},
    {kind: 'PersistentVolumeClaim', metadata: {namespace: 'default', name: 'runner'}},
    {kind: 'Deployment', metadata: {namespace: 'kube-system', name: 'aws-load-balancer-controller'}},
    {kind: 'Service', metadata: {namespace: 'default', name: 'app'}},
    {kind: 'Namespace', metadata: {name: 'tournament'}},
    {kind: 'Pod', metadata: {namespace: 'default', name: 'coredns-fake'}},
  ]) assert.throws(() => guardKubernetes([item]));
});

test('unknown and CloudShell interfaces block VPC deletion', () => {
  guardInterfaces([
    {Attachment: {InstanceId: 'i-worker'}},
    {Description: `Amazon EKS ${cluster}`},
    {InterfaceType: 'nat_gateway', Description: 'Interface for NAT Gateway nat-lab'},
  ], ['i-worker'], 'nat-lab');
  assert.throws(() => guardInterfaces([{NetworkInterfaceId: 'eni-shell', Description: 'CloudShell'}], [], 'nat-lab'));
  assert.throws(() => guardInterfaces([{Attachment: {InstanceId: 'i-foreign'}}], ['i-worker'], 'nat-lab'));
});

test('destroy without confirmation and unknown arguments never invoke tools', () => {
  const run = () => assert.fail('No tool should run');
  assert.throws(() => main(['destroy'], run), /explicit/);
  assert.throws(() => main(['destroy', `--confirm-account=${account}`, '--force'], run), /Unknown/);
});

test('empty state is a no-op; verify cannot claim an unapplied cluster passed', () => {
  const calls = [];
  const run = (binary, args) => {
    calls.push([binary, args]);
    if (binary === 'aws') return JSON.stringify({Account: account, Arn: `arn:aws:iam::${account}:user/metronome-lab`});
    if (args.includes('workspace')) return 'default\n';
    if (args.includes('show')) return '{}';
    assert.fail(`Unexpected command ${args}`);
  };
  main(['destroy', `--confirm-account=${account}`], run);
  assert.throws(() => main(['verify'], run), /No applied/);
  assert.equal(calls.some(([, args]) => args.includes('apply')), false);
});

test('foreign state and AWS failures stop before any deletion', () => {
  for (const failAws of [false, true]) {
    let applied = false;
    const run = (binary, args) => {
      if (args.includes('apply')) applied = true;
      if (binary === 'aws') {
        if (failAws) throw new Error('Expired session');
        return JSON.stringify({Account: account, Arn: `arn:aws:iam::${account}:user/metronome-lab`});
      }
      if (args.includes('workspace')) return 'default';
      return JSON.stringify(state([{...vpc, address: 'aws_efs_file_system.archive'}]));
    };
    assert.throws(() => main(['destroy', `--confirm-account=${account}`], run));
    assert.equal(applied, false);
  }
});

test('destroy orchestration reviews live inventory and saved plan before applying', () => {
  for (const blocker of [null, 'pvc', 'interface', 'replacement', 'apply-error']) {
    let applied = false;
    let applyAttempted = false;
    const arn = `arn:aws:eks:ap-southeast-1:${account}:cluster/${cluster}`;
    const eks = {address: 'aws_eks_cluster.lab', mode: 'managed', values: {id: cluster, name: cluster, arn, tags_all: tags}};
    const rs = [vpc, eks];
    const run = (binary, args) => {
      if (binary === 'aws') {
        const operation = args.slice(0, 2).join(' ');
        const responses = {
          'sts get-caller-identity': {Account: account, Arn: `arn:aws:iam::${account}:user/metronome-lab`},
          'eks list-clusters': {clusters: applied ? [] : [cluster]},
          'eks describe-cluster': {cluster: {arn, resourcesVpcConfig: {vpcId: 'vpc-owned'}}},
          'eks update-kubeconfig': {},
          'ec2 describe-vpcs': {Vpcs: applied ? [] : [{VpcId: 'vpc-owned', IsDefault: false,
            Tags: Object.entries(tags).map(([Key, Value]) => ({Key, Value}))}]},
          'elbv2 describe-load-balancers': {LoadBalancers: []},
          'elb describe-load-balancers': {LoadBalancerDescriptions: []},
          'ec2 describe-instances': {Reservations: []},
          'ec2 describe-network-interfaces': {NetworkInterfaces: blocker === 'interface' ? [{Description: 'CloudShell'}] : []},
          'ec2 describe-volumes': {Volumes: []},
          'ec2 describe-addresses': {Addresses: []},
          'ec2 describe-nat-gateways': {NatGateways: []},
        };
        assert.ok(operation in responses, operation);
        return JSON.stringify(responses[operation]);
      }
      if (binary === 'kubectl') return JSON.stringify({items: blocker === 'pvc' ? [{kind: 'PersistentVolumeClaim', metadata: {name: 'runner'}}] : []});
      if (args.includes('workspace')) return 'default';
      if (args.includes('show') && args.at(-1) !== '-json') return JSON.stringify({resource_changes: rs.map(r => deletion(r, blocker === 'replacement' ? ['delete', 'create'] : ['delete']))});
      if (args.includes('show')) return JSON.stringify(applied ? {} : state(rs));
      if (args.includes('plan')) {
        assert.equal(applied, false);
        assert.ok(args.includes('-destroy'));
        assert.ok(args.some(a => a.startsWith('-out=')));
        return '';
      }
      if (args.includes('apply')) {
        applyAttempted = true;
        assert.ok(args.at(-1).endsWith('destroy.tfplan'));
        if (blocker === 'apply-error') throw new Error('Provider deletion failed');
        applied = true;
        return '';
      }
      assert.fail(`Unexpected command ${args}`);
    };
    if (blocker) assert.throws(() => main(['destroy', `--confirm-account=${account}`], run));
    else main(['destroy', `--confirm-account=${account}`], run);
    assert.equal(applied, blocker === null);
    assert.equal(applyAttempted, blocker === null || blocker === 'apply-error');
  }
});
