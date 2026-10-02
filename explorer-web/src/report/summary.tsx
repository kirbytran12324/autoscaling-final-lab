import {formatNumber} from '../formatters';
import type {RunDetail} from '../types';
import {ReportSection, Metric} from './shared';

export function Summary({run}: {run: RunDetail}) {
  const champion = run.report.champion;
  return <ReportSection id="summary" title="Tournament outcome" subtitle="The final result and the evidence checks that matter most." back={false}>
    <div className="metric-grid headline-metrics">
      <Metric label="Champion" value={champion.champion.species} detail={`${champion.finalSeriesId} · ${champion.resolution}`} />
      <Metric label="Completion" value="Complete" />
      <Metric label="Participants" value={formatNumber(run.entrantCount)} />
      <Metric label="Accepted battles" value={formatNumber(run.matchCount)} />
      <Metric label="Integrity" value={run.report.integrity.verified ? 'Verified' : 'Review required'} />
    </div>
  </ReportSection>;
}

export function Verification({run}: {run: RunDetail}) {
  const integrity = run.report.integrity;
  return <ReportSection id="integrity" title="Verification" subtitle="Artifact checks establish the accepted result set and completed outcome." back={false}>
    <div className={`verified-banner ${integrity.verified ? '' : 'needs-review'}`}>
      <span className="verified-mark" aria-hidden="true">{integrity.verified ? '✓' : '!'}</span>
      <div><strong>{integrity.verified ? 'Verified' : 'Review required'}</strong><p>{formatNumber(integrity.uniqueMatchIds)} unique accepted battles; {formatNumber(integrity.terminalBattleFailures)} terminal battle failures.</p></div>
    </div>
    <details className="disclosure"><summary>Verification details</summary>
      <div className="metric-grid detail-metrics">
        <Metric label="Roster hash" value={run.rosterHash} detail={run.rosterHashVerified ? 'Verified' : 'Invalid'} className="hash-metric" />
        <Metric label="Expected accepted results" value={formatNumber(integrity.expectedAcceptedResults)} />
        <Metric label="Accepted result records" value={formatNumber(integrity.acceptedResultRecords)} />
        <Metric label="Unique match IDs" value={formatNumber(integrity.uniqueMatchIds)} detail="Authoritative accepted set" />
        <Metric label="Duplicate match IDs" value={formatNumber(integrity.duplicateMatchIds)} detail={integrity.duplicateMatchIds === 0 ? 'Check passed' : 'Identical deterministic duplicates'} />
        <Metric label="Invalid JSON records" value={formatNumber(integrity.invalidJsonRecords)} detail="All result records parsed successfully" />
        <Metric label="Terminal battle failures" value={formatNumber(integrity.terminalBattleFailures)} />
        <Metric label="Final checkpoint" value={`${run.checkpoint.stage} / ${run.checkpoint.round}`} detail={`${formatNumber(run.checkpoint.acceptedResultCount)} accepted`} />
        <Metric label="Standings status" value={integrity.standingsStatus} detail={`${formatNumber(integrity.standingsAcceptedResultCount)} / ${formatNumber(integrity.standingsExpectedResultCount)}`} />
        <Metric label="Knockout results" value={formatNumber(integrity.knockoutResultCount)} />
        <Metric label="Knockout rounds" value={formatNumber(integrity.knockoutRoundCount)} />
        <Metric label="Bracket status" value={integrity.bracketStatus} />
      </div>
      <div className="callout"><strong>Reproducibility boundary.</strong> Match identity, participants, seed, simulator version, outcome, winner, turns, termination, and protocol hash are deterministic result fields. <code>servedBy</code> and <code>durationMs</code> are operational observations and may differ when an identical battle is executed again. Result ordering can reflect bounded concurrent completion order; match IDs and accepted-result uniqueness are authoritative. Rules: {run.rulesVersion}.</div>
    </details>
  </ReportSection>;
}
