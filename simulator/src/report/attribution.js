'use strict';

const {MAX_DYNAMIC_STAGE_COLUMNS} = require('./constants');
const {escapeHtml, formatNumber} = require('./formatters');
const {sectionHeading, backToTop} = require('./ui');

function deriveSharedHostnamePrefix(hostnames) {
  const values = [...new Set(hostnames
    .filter(value => typeof value === 'string')
    .map(value => value.trim())
    .filter(Boolean))];
  if (values.length < 2) return '';
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let length = 0;
    const limit = Math.min(prefix.length, value.length);
    while (length < limit && prefix[length] === value[length]) length++;
    prefix = prefix.slice(0, length);
    if (prefix === '') return '';
  }
  const shortestLength = Math.min(...values.map(value => value.length));
  return prefix.length >= 3 && prefix.length < shortestLength ? prefix : '';
}

function aggregatePodAttribution(results) {
  const totalAcceptedCount = results.length;
  const pods = new Map();
  const stageTotals = new Map();
  let unattributedCount = 0;

  for (const result of results) {
    const hostname = typeof result.servedBy === 'string' ? result.servedBy.trim() : '';
    const stage = typeof result.stage === 'string' && result.stage.trim() !== ''
      ? result.stage.trim()
      : 'Unspecified';
    if (hostname === '') {
      unattributedCount++;
      continue;
    }
    if (!pods.has(hostname)) {
      pods.set(hostname, {fullHostname: hostname, acceptedCount: 0, stageCounts: {}});
    }
    const pod = pods.get(hostname);
    pod.acceptedCount++;
    pod.stageCounts[stage] = (pod.stageCounts[stage] || 0) + 1;
    stageTotals.set(stage, (stageTotals.get(stage) || 0) + 1);
  }

  const sharedPrefix = deriveSharedHostnamePrefix([...pods.keys()]);
  const rows = [...pods.values()]
    .map(pod => ({
      ...pod,
      sharedPrefix,
      distinguishingPart: sharedPrefix === ''
        ? pod.fullHostname
        : pod.fullHostname.slice(sharedPrefix.length),
      acceptedShare: totalAcceptedCount === 0
        ? 0
        : pod.acceptedCount / totalAcceptedCount * 100,
    }))
    .sort((left, right) =>
      right.acceptedCount - left.acceptedCount ||
      left.fullHostname.localeCompare(right.fullHostname)
    );
  const stages = [...stageTotals]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([stage, count]) => ({stage, count}));
  return {
    totalAcceptedCount,
    attributedCount: totalAcceptedCount - unattributedCount,
    unattributedCount,
    distinctHostnameCount: rows.length,
    stages,
    rows,
  };
}

function stageForResult(data, result) {
  if (typeof result.stage === 'string' && result.stage.trim() !== '') {
    return result.stage.trim();
  }
  return data.groupByMatchId.has(result.matchId) ? 'Group stage' : 'Knockout';
}

function attributedResults(data) {
  return data.results.map(result => ({...result, stage: stageForResult(data, result)}));
}

function renderPodAttribution(data) {
  const attribution = aggregatePodAttribution(attributedResults(data));
  if (attribution.distinctHostnameCount === 0) return '';
  const dynamicStages = attribution.stages.length <= MAX_DYNAMIC_STAGE_COLUMNS;
  const stageHeaders = dynamicStages
    ? attribution.stages.map(item => `<th>${escapeHtml(item.stage)}</th>`).join('')
    : '<th>Stage breakdown</th>';
  const rows = attribution.rows.map(row => {
    const stages = dynamicStages
      ? attribution.stages.map(item =>
        `<td>${formatNumber(row.stageCounts[item.stage] || 0)}</td>`
      ).join('')
      : `<td>${Object.entries(row.stageCounts)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([stage, count]) => `${escapeHtml(stage)}: ${formatNumber(count)}`)
        .join('<br>')}</td>`;
    const hostname = row.sharedPrefix === ''
      ? `<span class="hostname-full">${escapeHtml(row.fullHostname)}</span>`
      : `<span class="hostname-prefix">${escapeHtml(row.sharedPrefix)}</span>` +
        `<strong class="hostname-distinguishing">` +
        `${escapeHtml(row.distinguishingPart)}</strong>`;
    return `<tr><td><code class="pod-hostname" title="${escapeHtml(row.fullHostname)}" ` +
      `aria-label="${escapeHtml(row.fullHostname)}">${hostname}</code>` +
      `<button class="copy-button" type="button" ` +
      `data-copy="${escapeHtml(row.fullHostname)}" aria-label="Copy hostname ` +
      `${escapeHtml(row.fullHostname)}">Copy</button></td>` +
      `<td>${formatNumber(row.acceptedCount)}</td><td>${row.acceptedShare.toFixed(2)}%</td>` +
      `${stages}</tr>`;
  }).join('');
  const chart = attribution.rows.map(row => `<div class="pod-chart-row">` +
    `<div class="pod-chart-label"><code class="chart-hostname" ` +
    `title="${escapeHtml(row.fullHostname)}" aria-label="Full hostname: ` +
    `${escapeHtml(row.fullHostname)}">${escapeHtml(row.distinguishingPart)}</code>` +
    `<strong>${row.acceptedShare.toFixed(2)}%</strong></div>` +
    `<div class="share-track" role="img" aria-label="${escapeHtml(row.fullHostname)}: ` +
    `${row.acceptedShare.toFixed(2)} percent of accepted battles">` +
    `<span style="width:${row.acceptedShare.toFixed(4)}%"></span></div></div>`).join('');
  const stageSummary = attribution.stages.map(item =>
    `${item.stage}: ${formatNumber(item.count)}`
  ).join(' · ');
  const missing = attribution.unattributedCount === 0
    ? ''
    : `<p class="note">${formatNumber(attribution.unattributedCount)} accepted records ` +
      `had no usable reported hostname and are not assigned to a row.</p>`;
  return `<section id="pod-attribution">${sectionHeading(
    'Accepted battles by reported simulator Pod',
    'Accepted-response attribution shows how reported work was distributed.')}` +
    `<p class="compact-summary"><strong>${formatNumber(attribution.distinctHostnameCount)}</strong> ` +
    `reported simulator hostnames · ${formatNumber(attribution.totalAcceptedCount)} accepted battles` +
    `${stageSummary === '' ? '' : ` · ${escapeHtml(stageSummary)}`}</p>` +
    `<div class="pod-chart" aria-label="Relative workload share by reported hostname">` +
    `${chart}</div><div class="table-wrap"><table class="data-table primary-sticky pod-table">` +
    `<thead><tr>` +
    `<th>Reported simulator hostname</th><th>Accepted battles</th><th>Share</th>` +
    `${stageHeaders}</tr></thead><tbody>${rows}` +
    `</tbody></table></div>${missing}<div class="callout"><strong>Evidence boundary.</strong> ` +
    `<code>servedBy</code> is the hostname reported for an accepted response. It does ` +
    `not prove readiness, simultaneous availability, Pod UID, node placement, restart ` +
    `count, or lifecycle. Counts describe accepted-response attribution only. Per-Pod ` +
    `duration is not compared because workloads may differ between reported hostnames.` +
    `</div>${backToTop()}</section>`;
}

module.exports = {deriveSharedHostnamePrefix, aggregatePodAttribution, stageForResult, attributedResults, renderPodAttribution};
