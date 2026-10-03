'use strict';

const {operationalStats} = require('./metrics');
const {hashField, sectionHeading, metric, backToTop} = require('./ui');
const {escapeHtml, formatDuration, formatNumber} = require('./formatters');

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

module.exports = {renderRunDetails};
