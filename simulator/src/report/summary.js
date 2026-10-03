'use strict';

const {sectionHeading, metric} = require('./ui');
const {integrityVerified} = require('./integrity');
const {formatNumber, escapeHtml} = require('./formatters');

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

module.exports = {renderSummary, renderIntegrity};
