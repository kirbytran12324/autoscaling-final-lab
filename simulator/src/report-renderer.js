'use strict';

const SIMULATION_PAGE_SIZE = 25;
const STANDINGS_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = Object.freeze([25, 50, 100]);
const MAX_DYNAMIC_STAGE_COLUMNS = 4;

function isValidIsoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function embeddedJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : 'Unavailable';
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'Unavailable';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1000).toFixed(2).replace(/\.00$/, '')} s`;
  }
  let seconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  return [
    hours > 0 ? `${hours}h` : '',
    minutes > 0 || hours > 0 ? `${minutes}m` : '',
    `${seconds}s`,
  ].filter(Boolean).join(' ');
}

function percentile(sortedValues, percent) {
  if (sortedValues.length === 0) return null;
  const index = Math.ceil(percent * sortedValues.length) - 1;
  return sortedValues[Math.max(0, index)];
}

function metric(label, value, detail = '', classes = '') {
  const renderedValue = typeof value === 'number' ? formatNumber(value) : value;
  return `<div class="metric${classes === '' ? '' : ` ${classes}`}">` +
    `<span>${escapeHtml(label)}</span><strong>${escapeHtml(renderedValue)}</strong>` +
    (detail === '' ? '' : `<small>${escapeHtml(detail)}</small>`) + '</div>';
}

function hashField(value, label) {
  return `<code class="hash-value truncate" title="${escapeHtml(value)}" ` +
    `aria-label="${escapeHtml(label)}">${escapeHtml(value)}</code>`;
}

function sectionHeading(title, subtitle) {
  return `<div class="section-title"><h2>${escapeHtml(title)}</h2>` +
    `<p>${escapeHtml(subtitle)}</p></div>`;
}

function backToTop() {
  return '<a class="back-top" href="#top">Back to top <span aria-hidden="true">↑</span></a>';
}

function pageSizeOptions(selected = 25) {
  return PAGE_SIZE_OPTIONS.map(size => `<option value="${size}"` +
    `${size === selected ? ' selected' : ''}>${size}</option>`).join('');
}

function integrityVerified(data) {
  return data.rosterHashVerified && data.duplicateMatchIdCount === 0 &&
    data.uniqueResultCount === data.results.length && data.metadata.status === 'completed' &&
    data.checkpoint.stage === 'complete' && data.standings.status === 'final' &&
    data.bracket.status === 'completed';
}

function paginateRows(rows, requestedPage, pageSize) {
  const validPageSize = PAGE_SIZE_OPTIONS.includes(Number(pageSize)) ? Number(pageSize) : 25;
  const pageCount = Math.max(1, Math.ceil(rows.length / validPageSize));
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, pageCount - 1));
  return {
    entries: rows.slice(page * validPageSize, (page + 1) * validPageSize),
    matchCount: rows.length,
    page,
    pageCount,
    pageSize: validPageSize,
  };
}

function renderSummary(data) {
  const {metadata, roster, results, bracket} = data;
  return `<section id="summary">${sectionHeading('Tournament outcome',
    'The final result and the evidence checks that matter most.')}` +
    `<div class="metric-grid headline-metrics">${[
    metric('Champion', bracket.champion.champion.species,
      `${bracket.champion.finalSeriesId} · ${bracket.champion.resolution}`),
    metric('Completion', metadata.status === 'completed' ? 'Complete' : metadata.status),
    metric('Participants', roster.entrants.length),
    metric('Accepted battles', results.length),
    metric('Integrity', integrityVerified(data) ? 'Verified' : 'Review required'),
  ].join('')}</div></section>`;
}

function renderIntegrity(data) {
  const {metadata, results, failures, checkpoint, standings, bracket} = data;
  const knockoutResultCount = results.length - data.expectedGroupResultCount;
  const expectedTotal = data.expectedGroupResultCount + knockoutResultCount;
  const verified = integrityVerified(data) && data.uniqueResultCount === expectedTotal;
  return `<section id="integrity">${sectionHeading('Verification',
    'Artifact checks establish the accepted result set and completed outcome.')}` +
    `<div class="verified-banner ${verified ? '' : 'needs-review'}">` +
    `<span class="verified-mark" aria-hidden="true">${verified ? '✓' : '!'}</span>` +
    `<div><strong>${verified ? 'Verified' : 'Review required'}</strong>` +
    `<p>${formatNumber(data.uniqueResultCount)} unique accepted battles; ` +
    `${formatNumber(failures.length)} terminal battle failures.</p></div></div>` +
    `<details class="disclosure"><summary>Verification details</summary>` +
    `<div class="metric-grid detail-metrics">${[
      metric('Roster hash', data.roster.rosterHash,
        data.rosterHashVerified ? 'Verified' : 'Invalid', 'hash-metric'),
      metric('Expected accepted results', expectedTotal),
      metric('Accepted result records', data.uniqueResultCount),
      metric('Unique match IDs', data.uniqueResultCount, 'Authoritative accepted set'),
      metric('Duplicate match IDs', data.duplicateMatchIdCount,
        data.duplicateMatchIdCount === 0 ? 'Check passed' : 'Identical deterministic duplicates'),
      metric('Invalid JSON records', 0, 'All result records parsed successfully'),
      metric('Terminal battle failures', failures.length),
      metric('Final checkpoint', `${checkpoint.stage} / ${checkpoint.round}`,
        `${formatNumber(checkpoint.acceptedResultCount)} accepted`),
      metric('Standings status', standings.status,
        `${formatNumber(standings.acceptedResultCount)} / ` +
        `${formatNumber(standings.expectedResultCount)}`),
      metric('Knockout results', knockoutResultCount),
      metric('Knockout rounds', bracket.rounds.length),
      metric('Bracket status', bracket.status),
    ].join('')}</div>` +
    `<div class="callout"><strong>Reproducibility boundary.</strong> ` +
    `Match identity, participants, seed, simulator version, outcome, winner, turns, ` +
    `termination, and protocol hash are deterministic result fields. ` +
    `<code>servedBy</code> and <code>durationMs</code> are operational observations ` +
    `and may differ when an identical battle is executed again. Result ordering can ` +
    `reflect bounded concurrent completion order; match IDs and accepted-result ` +
    `uniqueness are authoritative. Rules: ${escapeHtml(metadata.rulesVersion)}.</div>` +
    `</details></section>`;
}

function paginateStandings(group, query, requestedPage, pageSize = STANDINGS_PAGE_SIZE) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase('en-US');
  const entries = group.standings.filter(entry =>
    normalizedQuery === '' || entry.species.toLocaleLowerCase('en-US').includes(normalizedQuery)
  );
  return paginateRows(entries, requestedPage, pageSize);
}

function standingRow(entry, advancingCount) {
  const classes = [
    entry.rank <= advancingCount ? 'advancing' : '',
    entry.rank === advancingCount ? 'cutoff-row' : '',
  ].filter(Boolean).join(' ');
  return `<tr${classes === '' ? '' : ` class="${classes}"`}>` +
    `<td>${formatNumber(entry.rank)}</td><td>${escapeHtml(entry.species)}</td>` +
    `<td>${formatNumber(entry.played)}</td><td>${formatNumber(entry.wins)}</td>` +
    `<td>${formatNumber(entry.draws)}</td><td>${formatNumber(entry.losses)}</td>` +
    `<td>${formatNumber(entry.points)}</td><td>${formatNumber(entry.miniTablePoints)}</td>` +
    `<td>${formatNumber(entry.sonnebornBerger)}</td>` +
    `<td>${hashField(entry.tieKey, `${entry.species} tie key`)}</td></tr>`;
}

function renderStandings(standings) {
  const tabs = standings.groups.map((group, index) =>
    `<button id="standings-tab-${index}" role="tab" type="button" ` +
    `aria-selected="${index === 0}" aria-controls="standings-panel-${index}" ` +
    `tabindex="${index === 0 ? 0 : -1}" data-group-index="${index}">` +
    `Group ${escapeHtml(group.group)}</button>`
  ).join('');
  const panels = standings.groups.map((group, index) => {
    const initial = paginateStandings(group, '', 0, STANDINGS_PAGE_SIZE);
    const rows = index === 0 ? initial.entries.map(entry =>
      standingRow(entry, standings.advancingCount)
    ).join('') : '';
    return `<article id="standings-panel-${index}" class="tab-panel" role="tabpanel" ` +
      `aria-labelledby="standings-tab-${index}" data-group-index="${index}"` +
      `${index === 0 ? '' : ' hidden'}><div class="section-heading"><h3>` +
      `Group ${escapeHtml(group.group)}</h3><p>${formatNumber(group.completedMatches)} / ` +
      `${formatNumber(group.expectedMatches)} matches · top ` +
      `${formatNumber(standings.advancingCount)} advance</p></div>` +
      `<div class="table-wrap large-table-wrap"><table class="data-table primary-sticky"><thead><tr>` +
      `<th>Rank</th><th>Species</th><th>P</th><th>W</th>` +
      `<th>D</th><th>L</th><th>Pts</th><th>Mini pts</th><th>SB</th>` +
      `<th>Tie key</th></tr></thead><tbody>${rows}</tbody></table></div></article>`;
  }).join('');
  return `<section id="standings">${sectionHeading('Group standings',
    'Compare placement and advancement while keeping the full field searchable.')}` +
    `<div class="table-toolbar" aria-label="Standings controls">` +
    `<label class="grow">Search <input id="standings-search" type="search" ` +
    `placeholder="Pokémon name" autocomplete="off"></label>` +
    `<label>Rows <select id="standings-page-size">` +
    `${pageSizeOptions(STANDINGS_PAGE_SIZE)}</select></label>` +
    `<output id="standings-count" aria-live="polite"></output>` +
    `<div class="pager"><button id="standings-prev" type="button">Previous</button>` +
    `<span id="standings-page" aria-live="polite"></span>` +
    `<button id="standings-next" type="button">Next</button></div></div>` +
    `<div class="tabs" role="tablist" aria-label="Tournament groups">${tabs}</div>` +
    `${panels}<p class="note">Standings contain every entrant from the validated artifact. ` +
    `Only the selected page is rendered.</p>${backToTop()}</section>`;
}

function renderGame(game) {
  const winner = game.outcome === 'tie' ? 'Draw' : game.winnerSpecies;
  return `<tr><td>${formatNumber(game.gameNumber)}</td>` +
    `<td>${hashField(game.matchId, 'Match ID')}</td>` +
    `<td>${escapeHtml(game.pokemon1)}</td><td>${escapeHtml(game.pokemon2)}</td>` +
    `<td>${hashField(game.seed.join(', '), 'Battle seed')}</td>` +
    `<td>${escapeHtml(game.outcome)} / ${escapeHtml(winner)}</td>` +
    `<td>${formatNumber(game.turns)}</td><td>${escapeHtml(game.termination)}</td>` +
    `<td>${hashField(game.protocolHash, 'Protocol hash')}</td></tr>`;
}

function roundCounts(round) {
  return {
    series: round.series.length,
    games: round.series.reduce((total, series) => total + series.games.length, 0),
  };
}

function renderRound(round, index) {
  const counts = roundCounts(round);
  const series = round.series.map(item => {
    const evaluation = item.evaluation;
    const lottery = evaluation.lotteryHash === null
      ? ''
      : `<p><strong>Series lottery hash:</strong> ` +
        `${hashField(evaluation.lotteryHash, 'Series lottery hash')}</p>`;
    const entrant1Class = evaluation.winner.species === item.entrant1.species ? 'winner' : 'loser';
    const entrant2Class = evaluation.winner.species === item.entrant2.species ? 'winner' : 'loser';
    return `<details class="series"><summary>` +
      `<strong class="series-score">${formatNumber(evaluation.entrant1Wins)}–` +
      `${formatNumber(evaluation.entrant2Wins)}</strong>` +
      `<span><span class="${entrant1Class}">${escapeHtml(item.entrant1.species)}</span> vs ` +
      `<span class="${entrant2Class}">${escapeHtml(item.entrant2.species)}</span></span>` +
      `<span class="series-winner">${escapeHtml(evaluation.winner.species)} advances</span>` +
      `<code title="${escapeHtml(item.seriesId)}">${escapeHtml(item.seriesId)}</code></summary>` +
      `<p>${formatNumber(evaluation.gamesPlayed)} games · ` +
      `${formatNumber(evaluation.draws)} draws · ${escapeHtml(evaluation.resolution)}</p>${lottery}` +
      `<div class="table-wrap"><table><thead><tr><th>Game</th><th>Match ID</th>` +
      `<th>Participant 1</th><th>Participant 2</th><th>Seed</th>` +
      `<th>Game outcome / game winner</th><th>Turns</th><th>Termination</th>` +
      `<th>Protocol hash</th></tr></thead><tbody>` +
      `${item.games.map(renderGame).join('')}</tbody></table></div></details>`;
  }).join('');
  return `<article id="round-panel-${index}" class="tab-panel round" role="tabpanel" ` +
    `aria-labelledby="round-tab-${index}" data-round-index="${index}"` +
    `${index === 0 ? '' : ' hidden'}><div class="section-heading"><h3>` +
    `${escapeHtml(round.round.toUpperCase())}</h3><p>${formatNumber(counts.series)} series · ` +
    `${formatNumber(counts.games)} games</p></div>${series}</article>`;
}

function renderBracket(bracket) {
  const champion = bracket.champion;
  const tabs = bracket.rounds.map((round, index) =>
    `<button id="round-tab-${index}" role="tab" type="button" ` +
    `aria-selected="${index === 0}" aria-controls="round-panel-${index}" ` +
    `tabindex="${index === 0 ? 0 : -1}" data-round-index="${index}">` +
    `${escapeHtml(round.round.toUpperCase())}</button>`
  ).join('');
  return `<section id="bracket">${sectionHeading('Knockout rounds',
    'Select a round, then expand a series for its complete game evidence.')}` +
    `<div class="champion"><span>Champion</span>` +
    `<strong>${escapeHtml(champion.champion.species)}</strong>` +
    `<small>Group ${escapeHtml(champion.champion.group)}, rank ` +
    `${formatNumber(champion.champion.rank)}; advanced from ` +
    `${escapeHtml(champion.champion.sourceSeriesId)} into ` +
    `${escapeHtml(champion.finalSeriesId)}; ${escapeHtml(champion.resolution)} after ` +
    `${formatNumber(champion.gamesPlayed)} games.</small></div>` +
    `<div class="tabs" role="tablist" aria-label="Knockout rounds">${tabs}</div>` +
    `${bracket.rounds.map(renderRound).join('')}${backToTop()}</section>`;
}

function operationalStats(results, failures, metadata) {
  const durations = results.map(result => result.durationMs).sort((a, b) => a - b);
  const slowest = [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
  return {
    wallClockMs: Date.parse(metadata.completedAt) - Date.parse(metadata.startedAt),
    durations: {
      min: durations[0], median: percentile(durations, 0.5),
      p95: percentile(durations, 0.95), p99: percentile(durations, 0.99),
      max: durations.at(-1),
      mean: durations.reduce((sum, value) => sum + value, 0) / durations.length,
    },
    wins: results.filter(result => result.outcome === 'win').length,
    draws: results.filter(result => result.outcome === 'tie').length,
    turnCaps: results.filter(result => result.termination === 'turn-cap').length,
    terminalFailures: failures.length,
    slowest,
  };
}

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

function renderRunDetails(data, generatedAt) {
  const stats = operationalStats(data.results, data.failures, data.metadata);
  const slowRows = stats.slowest.map(result => `<tr>` +
    `<td>${hashField(result.matchId, 'Match ID')}</td>` +
    `<td>${escapeHtml(result.pokemon1)} vs ${escapeHtml(result.pokemon2)}</td>` +
    `<td>${formatDuration(result.durationMs)}</td><td>${formatNumber(result.turns)}</td>` +
    `<td>${escapeHtml(result.servedBy)}</td></tr>`).join('');
  return `<section id="details">${sectionHeading('Run details',
    'Canonical configuration, timing, methodology, and reproducibility context.')}` +
    `<details class="disclosure"><summary>Configuration and timing</summary>` +
    `<div class="metric-grid detail-metrics">${[
      metric('Run ID', data.metadata.runId),
      metric('Mode', data.metadata.mode),
      metric('Tournament seed', data.metadata.tournamentSeed),
      metric('Started', data.metadata.startedAt),
      metric('Completed', data.metadata.completedAt),
      metric('Wall-clock span', formatDuration(stats.wallClockMs),
        'Includes possible interruption and recovery time'),
      metric('Rules version', data.metadata.rulesVersion),
      metric('Simulator version', data.metadata.simulatorVersion),
      metric('Simulator image', data.metadata.simulatorImage),
      metric('Runner concurrency', data.metadata.runnerConcurrency),
    ].join('')}</div><div class="callout"><strong>Wall-clock interpretation.</strong> ` +
    `The span from <code>startedAt</code> to <code>completedAt</code> may include ` +
    `interruption, diagnosis, and recovery time; it is not active runner execution time.` +
    `</div></details><details class="disclosure"><summary>Outcome and duration statistics</summary>` +
    `<div class="metric-grid detail-metrics">${[
      metric('Wins', stats.wins), metric('Draws', stats.draws),
      metric('Turn-cap terminations', stats.turnCaps),
      metric('Terminal battle failures', stats.terminalFailures),
      metric('Minimum battle duration', formatDuration(stats.durations.min)),
      metric('Mean battle duration', formatDuration(stats.durations.mean)),
      metric('Median battle duration', formatDuration(stats.durations.median)),
      metric('p95 battle duration', formatDuration(stats.durations.p95)),
      metric('p99 battle duration', formatDuration(stats.durations.p99)),
      metric('Maximum battle duration', formatDuration(stats.durations.max)),
    ].join('')}</div></details><details class="disclosure"><summary>` +
    `Slowest accepted simulations</summary>` +
    `<p>These are individual observations, not a per-Pod performance comparison.</p>` +
    `<div class="table-wrap"><table><thead><tr><th>Match ID</th><th>Participants</th>` +
    `<th>Duration</th><th>Turns</th><th>Reported hostname</th></tr></thead>` +
    `<tbody>${slowRows}</tbody></table></div></details>` +
    `<details class="disclosure"><summary>Methodology, sources, and limitations</summary><dl>` +
    `<dt>Generated at</dt><dd>${escapeHtml(generatedAt)}</dd>` +
    `<dt>Source artifacts</dt><dd>${data.sourceFiles.map(escapeHtml).join(', ')}</dd>` +
    `<dt>Authority</dt><dd><code>results.jsonl</code> remains authoritative for accepted ` +
    `simulations; this HTML is derived and regenerable.</dd>` +
    `<dt>Tournament scope</dt><dd>${data.metadata.mode === 'sample'
      ? 'This report represents the supplied sample-mode tournament.'
      : 'This report represents the supplied full-mode tournament.'}</dd>` +
    `<dt>Report behavior</dt><dd>Read-only and self-contained. It makes no network ` +
    `requests and modifies no tournament artifact.</dd>` +
    `<dt>Ordering</dt><dd>Persisted result ordering may reflect bounded concurrent ` +
    `completion order. Match IDs and accepted-result uniqueness determine authority.</dd>` +
    `<dt>Limitations</dt><dd>Reported hostname and duration values are operational ` +
    `observations, not deterministic replay fields or lifecycle telemetry.</dd></dl>` +
    `</details>${backToTop()}</section>`;
}

function simulationData(data) {
  return data.results.map(result => {
    const group = data.groupByMatchId.get(result.matchId);
    const roundMatch = /^(r\d+)-/.exec(result.matchId);
    return {
      matchId: result.matchId,
      stage: stageForResult(data, result),
      group: group || '',
      round: roundMatch === null ? '' : roundMatch[1],
      pokemon1: result.pokemon1,
      pokemon2: result.pokemon2,
      result: result.outcome,
      winnerSide: result.winnerSide,
      winner: result.winnerSpecies || 'Draw',
      turns: result.turns,
      termination: result.termination,
      servedBy: result.servedBy,
      durationMs: result.durationMs,
      seed: result.seed,
      simulatorVersion: result.simulatorVersion,
      protocolHash: result.protocolHash,
    };
  }).sort((left, right) => left.matchId.localeCompare(right.matchId));
}

const SIMULATION_COLUMNS = Object.freeze([
  'matchId', 'stage', 'group', 'round', 'pokemon1', 'pokemon2', 'result',
  'winnerSide', 'winner', 'turns', 'termination', 'servedBy', 'durationMs', 'seed',
  'protocolHash',
]);

function simulationPayload(rows) {
  return {
    schemaVersion: 1,
    shared: {simulatorVersion: rows[0]?.simulatorVersion || ''},
    columns: SIMULATION_COLUMNS,
    rows: rows.map(row => SIMULATION_COLUMNS.map(column => row[column])),
  };
}

function renderSimulationTable(data, simulations) {
  const pods = [...new Set(data.results.map(result => result.servedBy).filter(Boolean))].sort();
  const stages = [...new Set(simulations.map(row => row.stage))].sort();
  return `<section id="simulations">${sectionHeading('Battle explorer',
    'Filter accepted battles, then select a row to inspect its complete record.')}` +
    `<details id="simulation-explorer" class="disclosure"><summary>` +
    `Search and browse ${formatNumber(data.uniqueResultCount)} accepted simulations</summary>` +
    `<div class="table-toolbar" aria-label="Battle explorer controls">` +
    `<label class="grow">Search <input id="sim-search" type="search" ` +
    `placeholder="Match ID or species" autocomplete="off"></label>` +
    `<label>Stage <select id="sim-stage"><option value="">All</option>` +
    stages.map(stage => `<option value="${escapeHtml(stage)}">${escapeHtml(stage)}</option>`).join('') +
    `</select></label><label>Result <select id="sim-result"><option value="">All</option>` +
    `<option value="win">Win</option><option value="tie">Tie</option></select></label>` +
    `<label>Reported hostname <select id="sim-pod"><option value="">All</option>` +
    pods.map(pod => `<option value="${escapeHtml(pod)}">${escapeHtml(pod)}</option>`).join('') +
    `</select></label><label>Rows <select id="sim-page-size">` +
    `${pageSizeOptions(SIMULATION_PAGE_SIZE)}</select></label>` +
    `<button id="sim-reset" type="button">Reset filters</button>` +
    `<output id="sim-count" aria-live="polite">Expand to load.</output>` +
    `<div class="pager"><button id="sim-prev" type="button">Previous</button>` +
    `<span id="sim-page" aria-live="polite"></span>` +
    `<button id="sim-next" type="button">Next</button></div></div>` +
    `<div class="explorer-layout"><div class="table-wrap large-table-wrap"><table id="simulation-table" ` +
    `class="data-table primary-sticky selectable-table"><thead><tr>` +
    `<th data-sort="matchId">Match ID</th><th data-sort="stage">Stage</th>` +
    `<th data-sort="pokemon1">Matchup</th>` +
    `<th data-sort="result">Result</th><th data-sort="winner">Winner</th>` +
    `<th data-sort="turns">Turns</th></tr></thead><tbody></tbody></table></div>` +
    `<aside id="sim-detail" class="record-detail" aria-live="polite">` +
    `<p>Select a battle to view the complete accepted record.</p></aside></div>` +
    `<p class="note">Only the selected page is rendered. Filtering and sorting still ` +
    `operate locally on every embedded accepted record.</p></details>${backToTop()}</section>`;
}

const CSS = `
:root{color-scheme:dark;--bg:#09111f;--panel:#111d30;--panel-strong:#16243a;--surface:#0c1728;--ink:#edf3fc;--muted:#b6c3d4;--accent:#62d6c5;--gold:#f3c969;--line:#344760;--danger:#ef7d8d;--space-1:6px;--space-2:10px;--space-3:16px;--space-4:24px;--radius:12px;--shadow:0 14px 42px #0004;--mono:ui-monospace,SFMono-Regular,Consolas,monospace}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:78px}body{margin:0;background:radial-gradient(circle at 15% 0,#18304d 0,transparent 35%),var(--bg);color:var(--ink);font:15.5px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}header,main,footer{max-width:1440px;margin:auto;padding-inline:var(--space-4)}.report-header{padding-block:22px 16px}.report-header p{margin:0;text-transform:uppercase;letter-spacing:.13em;font-size:.76rem}.report-header h1{font-size:clamp(1.8rem,4vw,3rem);line-height:1.08;margin:4px 0}.report-header .champion-line{color:var(--accent);font-size:.95rem;margin:0}.report-header .champion-line strong{color:var(--gold)}h2{margin:0;font-size:clamp(1.45rem,2vw,1.85rem)}h3{margin:0}p{color:var(--muted)}.section-title{margin-bottom:var(--space-3)}.section-title p{margin:4px 0 0;max-width:76ch}.section-nav{position:sticky;top:0;z-index:30;margin:0;padding:9px max(24px,calc((100vw - 1392px)/2));display:flex;gap:8px;overflow-x:auto;scrollbar-width:thin;background:#09111ff2;border-block:1px solid var(--line);backdrop-filter:blur(12px)}.section-nav a{flex:0 0 auto;color:var(--ink);text-decoration:none;background:var(--panel);border:1px solid var(--line);padding:9px 13px;border-radius:99px}.section-nav a:hover,.section-nav a[aria-current="location"]{border-color:var(--accent);background:#153f3b;color:#fff}main{padding-block:6px 28px}section{background:rgba(17,29,48,.95);border:1px solid var(--line);border-radius:16px;padding:var(--space-4);margin:18px 0;box-shadow:var(--shadow);scroll-margin-top:78px}.metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:var(--space-2)}.headline-metrics{grid-template-columns:repeat(5,minmax(0,1fr))}.metric{background:var(--panel-strong);border-left:3px solid var(--accent);padding:12px;border-radius:8px;min-width:0}.metric span,.metric small{display:block;color:var(--muted)}.metric strong{display:block;font-size:1.08rem;overflow-wrap:anywhere}.headline-metrics .metric:first-child strong{color:var(--gold);font-size:1.3rem}.metric.hash-metric strong{font:12px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.metric small{font-size:.8rem}.verified-banner{display:flex;align-items:center;gap:14px;padding:15px 18px;border:1px solid #3e8e82;background:#11332f;border-radius:var(--radius)}.verified-banner.needs-review{border-color:var(--danger);background:#3a1d28}.verified-mark{display:grid;place-items:center;width:38px;height:38px;flex:0 0 auto;border-radius:50%;background:var(--accent);color:#071b18;font-size:1.4rem;font-weight:900}.verified-banner strong{font-size:1.3rem}.verified-banner p{margin:0}.disclosure,.series{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);margin:10px 0;padding:10px 14px}.disclosure>summary,.series>summary{cursor:pointer;font-weight:750;color:var(--accent);padding:8px 4px;min-height:42px}.detail-metrics{margin-top:12px}.callout{margin-top:16px;padding:15px;border-radius:9px;background:#0a1526;border:1px solid var(--line)}code{font:12px var(--mono);color:#bbf4e9}.truncate,.identifier{display:inline-block;max-width:22ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}.table-wrap{overflow:auto;max-width:100%;border:1px solid var(--line);border-radius:9px;background:var(--surface)}.large-table-wrap{max-height:68vh}table{border-collapse:separate;border-spacing:0;width:100%;font-size:.94rem;font-variant-numeric:tabular-nums}th,td{border-bottom:1px solid var(--line);padding:10px 12px;text-align:left;white-space:nowrap}th{color:var(--accent);position:sticky;top:0;background:var(--panel);z-index:3}tbody tr{transition:background-color .15s}tbody tr:hover{background:#ffffff0b}tbody tr:nth-child(even){background:#ffffff05}tbody tr:nth-child(even):hover{background:#ffffff0d}.primary-sticky th:first-child,.primary-sticky td:first-child{position:sticky;left:0;background:var(--surface);z-index:2;box-shadow:1px 0 0 var(--line)}.primary-sticky th:first-child{z-index:5;background:var(--panel)}tr.advancing, tr.advancing td:first-child{background:#163a37}tr.advancing:nth-child(even),tr.advancing:nth-child(even) td:first-child{background:#18423e}.cutoff-row td{border-bottom:3px solid var(--gold)}.selectable-table tbody tr{cursor:pointer}.selectable-table tbody tr[aria-selected="true"],.selectable-table tbody tr[aria-selected="true"] td:first-child{background:#254c63;box-shadow:inset 3px 0 0 var(--gold)}.empty-state{text-align:center;color:var(--muted);padding:30px}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 16px}.tabs button{margin:0}.tabs button[aria-selected="true"]{border-color:var(--accent);background:#153f3b;color:#fff}.tab-panel{margin-top:8px}.section-heading{display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin:10px 0}.section-heading p{margin:0}.table-toolbar{position:relative;display:flex;align-items:end;gap:10px;flex-wrap:wrap;margin:12px 0;padding:10px;background:#0a1526;border:1px solid var(--line);border-radius:var(--radius)}.table-toolbar.sticky-tools{position:sticky;top:64px;z-index:12}.table-toolbar label{color:var(--muted);font-size:.82rem}.table-toolbar .grow{flex:1 1 220px}.table-toolbar .grow input{width:100%}.table-toolbar output{margin-left:auto;min-width:120px;color:var(--muted)}input,select,button{display:block;min-height:42px;margin-top:4px;background:#081321;color:var(--ink);border:1px solid var(--line);border-radius:7px;padding:8px 11px;font:inherit}button{margin-top:0}button:not(:disabled){cursor:pointer}button:disabled{opacity:.45}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,tr:focus-visible{outline:3px solid var(--gold);outline-offset:2px}th[data-sort]{cursor:pointer}.pager{display:flex;align-items:center;gap:8px}.pager span{min-width:104px;text-align:center;color:var(--muted)}.champion{display:grid;grid-template-columns:auto auto 1fr;align-items:center;gap:10px 18px;padding:15px 18px;margin:8px 0 18px;background:linear-gradient(130deg,#473b17,#182943);border-radius:var(--radius)}.champion strong{font-size:1.75rem;color:var(--gold)}.champion small{color:var(--muted)}.series>summary{display:grid;grid-template-columns:70px minmax(220px,1fr) minmax(160px,.65fr) auto;align-items:center;gap:12px}.series-score{font-size:1.2rem;color:var(--gold)}.series .winner{font-weight:800;color:var(--ink)}.series .loser{color:var(--muted)}.series-winner{color:var(--accent);font-weight:700}.compact-summary{padding:10px 13px;background:var(--surface);border-radius:8px}.pod-chart{display:grid;gap:10px;margin:14px 0 18px;padding:15px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius)}.pod-chart-row{display:grid;grid-template-columns:minmax(180px,320px) 1fr;align-items:center;gap:14px}.pod-chart-label{display:flex;justify-content:space-between;gap:10px}.share-track{width:100%;height:13px;background:#07111f;border:1px solid var(--line);border-radius:99px;overflow:hidden}.share-track span{display:block;height:100%;min-width:2px;background:repeating-linear-gradient(135deg,var(--accent),var(--accent) 8px,#3fb9aa 8px,#3fb9aa 16px)}.copy-button{display:inline-block;min-height:30px;margin:0 0 0 8px;padding:3px 8px;font-size:.78rem}.explorer-layout{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(280px,.75fr);gap:14px;align-items:start}.record-detail{position:sticky;top:156px;min-height:190px;padding:16px;background:var(--panel-strong);border:1px solid var(--line);border-radius:var(--radius)}.record-detail h3{color:var(--accent);margin-bottom:10px}.record-detail dl{grid-template-columns:110px minmax(0,1fr);font-size:.9rem}.record-detail dd{overflow-wrap:anywhere}.note{font-size:.88rem}.back-top{display:block;width:max-content;margin:18px 0 0 auto;color:var(--accent)}dl{display:grid;grid-template-columns:180px minmax(0,1fr);gap:8px 20px}dt{font-weight:700;color:var(--accent)}dd{margin:0;color:var(--muted);overflow-wrap:anywhere}footer{padding-block:12px 28px;color:var(--muted);text-align:center}
:root{--sticky-nav-height:64px}html{scroll-padding-top:calc(var(--sticky-nav-height) + var(--space-3))}section{scroll-margin-top:calc(var(--sticky-nav-height) + var(--space-3))}.pod-table th:first-child,.pod-table td:first-child{min-width:360px;max-width:480px;white-space:normal}.pod-hostname{display:inline;white-space:normal;overflow-wrap:anywhere;font-family:var(--mono);line-height:1.55}.hostname-prefix{color:var(--muted);font-weight:400}.hostname-distinguishing{display:inline-block;color:var(--gold);font-weight:850}.hostname-full{color:var(--ink);font-weight:500}.chart-hostname{max-width:100%;white-space:normal;overflow-wrap:anywhere;color:var(--ink);font-weight:800}.record-detail{top:calc(var(--sticky-nav-height) + 92px)}
@media(max-width:1000px){.headline-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.explorer-layout{grid-template-columns:1fr}.record-detail{position:static}.series>summary{grid-template-columns:60px 1fr}.series>summary code,.series-winner{grid-column:2}}
@media(max-width:700px){header,main,footer{padding-inline:14px}.section-nav{padding-inline:14px}.report-header{padding-block:14px 10px}.headline-metrics{grid-template-columns:1fr 1fr}.headline-metrics .metric:first-child{grid-column:1/-1}.section-heading{align-items:stretch;flex-direction:column}.table-toolbar{align-items:stretch}.table-toolbar>*{flex:1 1 130px}.table-toolbar .pager{flex:1 0 100%;justify-content:space-between}.table-toolbar output{margin-left:0}.pod-chart-row{grid-template-columns:1fr;gap:5px}.pod-table th:first-child,.pod-table td:first-child{min-width:280px;max-width:320px}.pod-hostname{display:block}.copy-button{margin:5px 0 0}.champion{grid-template-columns:1fr;text-align:center}.series>summary{grid-template-columns:50px 1fr}.detail-metrics{grid-template-columns:1fr}dl{grid-template-columns:1fr}section{padding:16px}}
@media print{:root{color-scheme:light}body{background:#fff;color:#111;font-size:10pt}.section-nav,.tabs,.table-toolbar,.back-top,.copy-button{display:none!important}header,main,footer{max-width:none;padding:8px}section{background:#fff;border:1px solid #aaa;box-shadow:none;break-inside:avoid}.tab-panel[hidden]{display:block!important}.series{break-inside:avoid}.table-wrap{overflow:visible}th,.primary-sticky th:first-child{position:static;background:#eee;color:#111}p,dd,.metric span,.metric small{color:#333}.disclosure:not([open])>*:not(summary){display:block}}
`;

const CLIENT_FUNCTIONS = `const PAGE_SIZE_OPTIONS=${embeddedJson(PAGE_SIZE_OPTIONS)};` +
  `${paginateRows.toString()}${paginateStandings.toString()}`;

const SCRIPT = `
'use strict';
${CLIENT_FUNCTIONS}
function addCell(row,value,truncate=false){const cell=document.createElement('td');if(truncate){const code=document.createElement('code');code.className='truncate';code.textContent=value;code.title=value;cell.append(code)}else cell.textContent=value;row.append(cell);return cell}
function emptyRow(body,colspan,message){const row=document.createElement('tr');const cell=document.createElement('td');cell.colSpan=colspan;cell.className='empty-state';cell.textContent=message;row.append(cell);body.append(row)}
function createPager(config,onChange){let page=0;let pageSize=config.defaultSize;let total=0;const previous=document.getElementById(config.previous);const next=document.getElementById(config.next);const label=document.getElementById(config.label);const size=document.getElementById(config.size);function sync(nextTotal){total=nextTotal;const pages=Math.max(1,Math.ceil(total/pageSize));page=Math.min(page,pages-1);label.textContent='Page '+(page+1).toLocaleString('en-US')+' of '+pages.toLocaleString('en-US');previous.disabled=page===0;next.disabled=page>=pages-1;return page}previous.addEventListener('click',()=>{if(page>0){page--;onChange()}});next.addEventListener('click',()=>{if((page+1)*pageSize<total){page++;onChange()}});size.addEventListener('change',()=>{const start=page*pageSize;pageSize=PAGE_SIZE_OPTIONS.includes(Number(size.value))?Number(size.value):25;page=Math.floor(start/pageSize);onChange()});return{get page(){return page},get pageSize(){return pageSize},sync,reset(){page=0}}}
const standings=JSON.parse(document.getElementById('standings-data').textContent);let selectedGroup=0;
const standingsSearch=document.getElementById('standings-search');const standingsCount=document.getElementById('standings-count');const standingsTabs=[...document.querySelectorAll('[data-group-index][role="tab"]')];const standingsPanels=[...document.querySelectorAll('#standings .tab-panel')];
const standingsPager=createPager({previous:'standings-prev',next:'standings-next',label:'standings-page',size:'standings-page-size',defaultSize:${STANDINGS_PAGE_SIZE}},renderStandingsPanel);
function renderStandingsPanel(){const group=standings.groups[selectedGroup];const state=paginateStandings(group,standingsSearch.value,standingsPager.page,standingsPager.pageSize);standingsPager.sync(state.matchCount);const panel=standingsPanels[selectedGroup];const body=panel.querySelector('tbody');body.replaceChildren();if(state.entries.length===0)emptyRow(body,10,'No standings match this search.');for(const item of state.entries){const row=document.createElement('tr');if(item.rank<=standings.advancingCount)row.classList.add('advancing');if(item.rank===standings.advancingCount)row.classList.add('cutoff-row');for(const key of ['rank','species','played','wins','draws','losses','points','miniTablePoints','sonnebornBerger'])addCell(row,item[key]);addCell(row,item.tieKey,true);body.append(row)}standingsCount.textContent=state.matchCount.toLocaleString('en-US')+' matching entrants'}
function selectGroup(index,focus=true){selectedGroup=index;standingsPager.reset();standingsTabs.forEach((tab,itemIndex)=>{const active=itemIndex===index;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;if(active&&focus)tab.focus()});standingsPanels.forEach((panel,itemIndex)=>{panel.hidden=itemIndex!==index;if(itemIndex!==index)panel.querySelector('tbody').replaceChildren()});renderStandingsPanel()}
standingsTabs.forEach((tab,index)=>{tab.addEventListener('click',()=>selectGroup(index,false));tab.addEventListener('keydown',event=>{let next=index;if(event.key==='ArrowRight')next=(index+1)%standingsTabs.length;else if(event.key==='ArrowLeft')next=(index-1+standingsTabs.length)%standingsTabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=standingsTabs.length-1;else return;event.preventDefault();selectGroup(next)})});standingsSearch.addEventListener('input',renderStandingsPanel);renderStandingsPanel();
const roundTabs=[...document.querySelectorAll('[data-round-index][role="tab"]')];const roundPanels=[...document.querySelectorAll('#bracket .tab-panel')];function selectRound(index,focus=true){roundTabs.forEach((tab,itemIndex)=>{const active=itemIndex===index;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;if(active&&focus)tab.focus()});roundPanels.forEach((panel,itemIndex)=>panel.hidden=itemIndex!==index)}roundTabs.forEach((tab,index)=>{tab.addEventListener('click',()=>selectRound(index,false));tab.addEventListener('keydown',event=>{let next=index;if(event.key==='ArrowRight')next=(index+1)%roundTabs.length;else if(event.key==='ArrowLeft')next=(index-1+roundTabs.length)%roundTabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=roundTabs.length-1;else return;event.preventDefault();selectRound(next)})});
let simulationInitialized=false;let simulations=[];let simulationColumns={};let simulationShared={};let sortKey='matchId';let sortDirection=1;let filtered=[];let filterTimer;let selectedMatchId='';
const explorer=document.getElementById('simulation-explorer');const simBody=document.querySelector('#simulation-table tbody');const simCount=document.getElementById('sim-count');const simDetail=document.getElementById('sim-detail');const simControls={search:document.getElementById('sim-search'),stage:document.getElementById('sim-stage'),result:document.getElementById('sim-result'),pod:document.getElementById('sim-pod')};const simPager=createPager({previous:'sim-prev',next:'sim-next',label:'sim-page',size:'sim-page-size',defaultSize:${SIMULATION_PAGE_SIZE}},renderSimulations);
function simValue(row,key){return row[simulationColumns[key]]}function simCompare(a,b){const left=simValue(a,sortKey),right=simValue(b,sortKey);return (typeof left==='number'?left-right:String(left).localeCompare(String(right)))*sortDirection}
function appendDetail(dl,label,value,copy=false){const term=document.createElement('dt');term.textContent=label;const description=document.createElement('dd');const text=value===null||value===undefined||value===''?'Not reported':Array.isArray(value)?value.join(', '):String(value);const span=document.createElement('span');span.textContent=text;span.title=text;description.append(span);if(copy&&text!=='Not reported'){const button=document.createElement('button');button.type='button';button.className='copy-button';button.dataset.copy=text;button.textContent='Copy';button.setAttribute('aria-label','Copy '+label);description.append(button)}dl.append(term,description)}
function showSimulationDetail(item){selectedMatchId=String(simValue(item,'matchId'));simDetail.replaceChildren();const title=document.createElement('h3');title.textContent='Battle '+selectedMatchId;const dl=document.createElement('dl');for(const field of [['Stage','stage'],['Group','group'],['Round','round'],['Participant 1','pokemon1'],['Participant 2','pokemon2'],['Outcome','result'],['Winner side','winnerSide'],['Winner','winner'],['Turns','turns'],['Termination','termination'],['Reported hostname','servedBy',true],['Duration (ms)','durationMs'],['Seed','seed',true]])appendDetail(dl,field[0],simValue(item,field[1]),field[2]);appendDetail(dl,'Simulator version',simulationShared.simulatorVersion);appendDetail(dl,'Protocol hash',simValue(item,'protocolHash'),true);simDetail.append(title,dl);renderSimulations()}
function clearSimulationDetail(){selectedMatchId='';simDetail.replaceChildren();const prompt=document.createElement('p');prompt.textContent='Select a battle to view the complete accepted record.';simDetail.append(prompt)}
function renderSimulations(){if(!simulationInitialized)return;simPager.sync(filtered.length);simBody.replaceChildren();const start=simPager.page*simPager.pageSize;const visible=filtered.slice(start,start+simPager.pageSize);if(visible.length===0)emptyRow(simBody,6,'No accepted battles match these filters.');for(const item of visible){const row=document.createElement('tr');const matchId=String(simValue(item,'matchId'));row.tabIndex=0;row.setAttribute('aria-selected',String(matchId===selectedMatchId));row.setAttribute('aria-label','Open details for '+matchId);row.addEventListener('click',()=>showSimulationDetail(item));row.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();showSimulationDetail(item)}});addCell(row,matchId,true);addCell(row,simValue(item,'stage'));addCell(row,simValue(item,'pokemon1')+' vs '+simValue(item,'pokemon2'));addCell(row,simValue(item,'result'));addCell(row,simValue(item,'winner'));addCell(row,simValue(item,'turns'));simBody.append(row)}simCount.textContent=filtered.length.toLocaleString('en-US')+' matching battles'}
function applySimulationFilters(){const query=simControls.search.value.trim().toLocaleLowerCase('en-US');filtered=simulations.filter(row=>(!query||String(simValue(row,'matchId')).toLocaleLowerCase('en-US').includes(query)||String(simValue(row,'pokemon1')).toLocaleLowerCase('en-US').includes(query)||String(simValue(row,'pokemon2')).toLocaleLowerCase('en-US').includes(query))&&(!simControls.stage.value||simValue(row,'stage')===simControls.stage.value)&&(!simControls.result.value||simValue(row,'result')===simControls.result.value)&&(!simControls.pod.value||simValue(row,'servedBy')===simControls.pod.value));if(sortKey!=='matchId'||sortDirection!==1)filtered.sort(simCompare);if(selectedMatchId&&!filtered.some(row=>String(simValue(row,'matchId'))===selectedMatchId))clearSimulationDetail();renderSimulations()}
function initializeSimulationExplorer(){if(simulationInitialized)return;const payload=JSON.parse(document.getElementById('simulation-data').textContent);payload.columns.forEach((name,index)=>simulationColumns[name]=index);simulationShared=payload.shared||{};simulations=payload.rows;simulationInitialized=true;applySimulationFilters()}
explorer.addEventListener('toggle',()=>{if(explorer.open)initializeSimulationExplorer()});for(const control of Object.values(simControls))control.addEventListener('input',()=>{clearTimeout(filterTimer);filterTimer=setTimeout(applySimulationFilters,120)});document.querySelectorAll('#simulation-table th[data-sort]').forEach(header=>header.addEventListener('click',()=>{initializeSimulationExplorer();const next=header.dataset.sort;if(sortKey===next)sortDirection*=-1;else{sortKey=next;sortDirection=1}applySimulationFilters()}));document.getElementById('sim-reset').addEventListener('click',()=>{for(const control of Object.values(simControls))control.value='';simPager.reset();applySimulationFilters();simControls.search.focus()});
async function copyText(value,button){try{await navigator.clipboard.writeText(value)}catch(error){const area=document.createElement('textarea');area.value=value;area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();document.execCommand('copy');area.remove()}const previous=button.textContent;button.textContent='Copied';setTimeout(()=>button.textContent=previous,1000)}document.addEventListener('click',event=>{const button=event.target.closest('[data-copy]');if(button)copyText(button.dataset.copy,button)});
const sectionNav=document.querySelector('.section-nav');function updateStickyNavHeight(){document.documentElement.style.setProperty('--sticky-nav-height',Math.ceil(sectionNav.getBoundingClientRect().height)+'px')}updateStickyNavHeight();window.addEventListener('resize',updateStickyNavHeight);if('ResizeObserver'in window)new ResizeObserver(updateStickyNavHeight).observe(sectionNav);
const navLinks=[...document.querySelectorAll('.section-nav a')];const observedSections=navLinks.map(link=>document.querySelector(link.getAttribute('href'))).filter(Boolean);if('IntersectionObserver'in window){const visible=new Map();const observer=new IntersectionObserver(entries=>{entries.forEach(entry=>visible.set(entry.target,entry.isIntersecting?entry.intersectionRatio:0));const active=[...visible].sort((left,right)=>right[1]-left[1])[0];if(active&&active[1]>0)navLinks.forEach(link=>link.toggleAttribute('aria-current',link.getAttribute('href')==='#'+active[0].id))},{rootMargin:'-70px 0px -55% 0px',threshold:[0,.1,.25,.5]});observedSections.forEach(section=>observer.observe(section))}
function openLinkedDetails(){const target=document.querySelector(location.hash);if(target&&target.tagName==='SECTION'){const details=target.querySelector(':scope > details');if(details)details.open=true}}window.addEventListener('hashchange',openLinkedDetails);openLinkedDetails();
`;

function renderReport(data, options = {}) {
  const generatedAt = options.generatedAt === undefined
    ? new Date().toISOString()
    : options.generatedAt;
  if (!isValidIsoTimestamp(generatedAt)) {
    throw new TypeError('Report generation timestamp must be a valid ISO timestamp');
  }
  const simulations = simulationData(data);
  const podAttribution = renderPodAttribution(data);
  const podNavigation = podAttribution === ''
    ? ''
    : `<a href="#pod-attribution">Pod attribution</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="dark">` +
    `<title>${escapeHtml(data.metadata.runId)} tournament report</title>` +
    `<style>${CSS}</style></head><body><header id="top" class="report-header">` +
    `<p>Metronome tournament · offline report</p>` +
    `<h1>${escapeHtml(data.metadata.runId)}</h1>` +
    `<p class="champion-line">Champion <strong>` +
    `${escapeHtml(data.bracket.champion.champion.species)}</strong></p></header>` +
    `<nav class="section-nav" aria-label="Report sections">` +
    `<a href="#summary">Summary</a><a href="#integrity">Verify</a>` +
    `<a href="#standings">Groups</a><a href="#bracket">Rounds</a>` +
    `<a href="#simulations">Battles</a>${podNavigation}` +
    `<a href="#details">Run details</a></nav><main>` +
    renderSummary(data) + renderIntegrity(data) + renderStandings(data.standings) +
    renderBracket(data.bracket) + renderSimulationTable(data, simulations) +
    podAttribution + renderRunDetails(data, generatedAt) +
    `</main><footer>Derived report · ${escapeHtml(generatedAt)}</footer>` +
    `<script id="standings-data" type="application/json">` +
    `${embeddedJson(data.standings)}</script>` +
    `<script id="simulation-data" type="application/json">` +
    `${embeddedJson(simulationPayload(simulations))}</script>` +
    `<script>${SCRIPT}</script></body></html>\n`;
}

module.exports = {
  MAX_DYNAMIC_STAGE_COLUMNS,
  PAGE_SIZE: SIMULATION_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  SIMULATION_PAGE_SIZE,
  STANDINGS_PAGE_SIZE,
  aggregatePodAttribution,
  deriveSharedHostnamePrefix,
  escapeHtml,
  formatDuration,
  formatNumber,
  paginateStandings,
  paginateRows,
  renderPodAttribution,
  renderReport,
  roundCounts,
};
