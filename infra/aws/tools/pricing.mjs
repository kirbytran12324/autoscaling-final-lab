#!/usr/bin/env node
// Read-only public on-demand quote. No budgets, purchases, account changes, or
// resource writes. Run again before apply; this is not a billing forecast or cap.
import {spawnSync} from 'node:child_process';
import {profile, region} from './foundation-guards.mjs';

function products(service, filters) {
  const args = ['pricing', 'get-products', '--service-code', service, '--region', 'us-east-1',
    '--profile', profile, '--filters', ...Object.entries({regionCode: region, ...filters})
      .map(([Field, Value]) => `Type=TERM_MATCH,Field=${Field},Value=${Value}`),
    '--output', 'json', '--no-cli-pager'];
  const result = spawnSync('aws', args, {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout).PriceList.map(JSON.parse).flatMap(p =>
    Object.values(p.terms.OnDemand ?? {}).flatMap(t => Object.values(t.priceDimensions).map(d => ({
      service, sku: p.product.sku, attributes: p.product.attributes,
      description: d.description, unit: d.unit, usd: Number(d.pricePerUnit.USD),
      beginRange: d.beginRange, endRange: d.endRange,
    }))));
}

const requests = {
  worker: ['AmazonEC2', {instanceType: 't3.medium', operatingSystem: 'Linux', tenancy: 'Shared',
    preInstalledSw: 'NA', capacitystatus: 'Used', operation: 'RunInstances'}],
  eks: ['AmazonEKS', {usagetype: 'APS1-AmazonEKS-Hours:perCluster'}],
  nat: ['AmazonEC2', {productFamily: 'NAT Gateway'}],
  gp3: ['AmazonEC2', {volumeApiName: 'gp3', productFamily: 'Storage'}],
  publicIpv4: ['AmazonVPC', {usagetype: 'APS1-PublicIPv4:InUseAddress'}],
};
try {
  const quotes = Object.fromEntries(Object.entries(requests).map(([name, args]) => [name, products(...args)]));
  const unique = (name, predicate = () => true) => {
    const matches = quotes[name].filter(predicate);
    if (matches.length !== 1 || !Number.isFinite(matches[0].usd)) throw new Error(`Expected one unambiguous ${name} price; inspect the current catalog.`);
    return matches[0];
  };
  const selected = {
    worker: unique('worker'), eks: unique('eks'), gp3: unique('gp3'), publicIpv4: unique('publicIpv4'),
    natHour: unique('nat', p => p.attributes.usagetype === 'APS1-NatGateway-Hours'),
    natGb: unique('nat', p => p.attributes.usagetype === 'APS1-NatGateway-Bytes'),
  };
  const fixedHourly = selected.eks.usd + 2 * selected.worker.usd + selected.natHour.usd +
    selected.publicIpv4.usd + 60 * selected.gp3.usd / 730;
  console.log(JSON.stringify({retrievedAt: new Date().toISOString(), region,
    rates: Object.fromEntries(Object.entries(selected).map(([k, v]) => [k, {usd: v.usd, unit: v.unit, sku: v.sku}])),
    estimate: {fixedHourly, eightHours: fixedHourly * 8, twentyFourHours: fixedHourly * 24},
    assumptions: 'Two t3.medium workers, 60 GiB gp3 total, one zonal NAT and public IPv4; EBS hourly approximation uses 730 hours/month.',
    excluded: 'NAT data, cross-AZ/internet transfer, logs, update surge, taxes, other services. Before credits/discounts; no spending cap.',
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
