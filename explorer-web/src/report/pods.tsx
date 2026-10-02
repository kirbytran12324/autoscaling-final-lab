import {formatNumber} from '../formatters';
import type {PodRow, RunDetail} from '../types';
import {CopyButton, ReportSection} from './shared';

export function PodHostname({row}: {row: PodRow}) {
  return <><code className="pod-hostname" title={row.fullHostname}>{row.sharedPrefix ? <><span className="hostname-prefix">{row.sharedPrefix}</span><strong className="hostname-distinguishing">{row.distinguishingPart}</strong></> : <span className="hostname-full">{row.fullHostname}</span>}</code><CopyButton value={row.fullHostname} label={`hostname ${row.fullHostname}`} /></>;
}

export function PodAttribution({run}: {run: RunDetail}) {
  const attribution = run.report.podAttribution;
  return <ReportSection id="pod-attribution" title="Accepted battles by reported simulator Pod" subtitle="Accepted-response attribution shows how reported work was distributed.">
    <p className="compact-summary"><strong>{formatNumber(attribution.distinctHostnameCount)}</strong> reported simulator hostnames · {formatNumber(attribution.totalAcceptedCount)} accepted battles{attribution.stages.map(item => ` · ${item.stage}: ${formatNumber(item.count)}`)}</p>
    <div className="pod-chart" aria-label="Relative workload share by reported hostname">{attribution.rows.map(row => <div className="pod-chart-row" key={row.fullHostname}><div className="pod-chart-label"><code className="chart-hostname" title={row.fullHostname}>{row.distinguishingPart}</code><strong>{row.acceptedShare.toFixed(2)}%</strong></div><div className="share-track" role="img" aria-label={`${row.fullHostname}: ${row.acceptedShare.toFixed(2)} percent of accepted battles`}><span style={{width: `${row.acceptedShare.toFixed(4)}%`}} /></div></div>)}</div>
    <div className="table-wrap"><table className="data-table primary-sticky pod-table"><thead><tr><th>Reported simulator hostname</th><th>Accepted battles</th><th>Share</th>{attribution.stages.map(item => <th key={item.stage}>{item.stage}</th>)}</tr></thead><tbody>{attribution.rows.map(row => <tr key={row.fullHostname}><td><PodHostname row={row} /></td><td>{formatNumber(row.acceptedCount)}</td><td>{row.acceptedShare.toFixed(2)}%</td>{attribution.stages.map(item => <td key={item.stage}>{formatNumber(row.stageCounts[item.stage] || 0)}</td>)}</tr>)}</tbody></table></div>
    {attribution.unattributedCount > 0 && <p className="note">{formatNumber(attribution.unattributedCount)} accepted records had no usable reported hostname and are not assigned to a row.</p>}
    <div className="callout"><strong>Evidence boundary.</strong> <code>servedBy</code> is the hostname reported for an accepted response. It does not prove readiness, simultaneous availability, Pod UID, node placement, restart count, or lifecycle. Counts describe accepted-response attribution only. Per-Pod duration is not compared because workloads may differ between reported hostnames.</div>
  </ReportSection>;
}
