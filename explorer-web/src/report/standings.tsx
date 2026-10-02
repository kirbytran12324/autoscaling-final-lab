import {usePaginatedRequest, usePagination} from '../usePaginatedRequest';
import {KeyboardEvent, useRef, useState} from 'react';
import {listStandings} from '../api';
import {formatNumber} from '../formatters';
import {ReportSection, Pager, EmptyRow} from './shared';
import {PAGE_SIZES} from './constants';

export function Standings({runId}: {runId: string}) {
  const [group, setGroup] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(25);
  const {cursor, history, resetPage, previous, next} = usePagination();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const requestKey = JSON.stringify([runId, group, query, limit, cursor]);
  const {page, pending, error} = usePaginatedRequest(requestKey,
    signal => listStandings(runId, {group, query, limit, cursor}, signal),
    result => { if (!group) setGroup(result.selectedGroup); });
  const selectGroup = (next: string) => { setGroup(next); resetPage(); };
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!page) return;
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % page.groups.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + page.groups.length) % page.groups.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = page.groups.length - 1;
    else return;
    event.preventDefault();
    selectGroup(page.groups[next].group);
    tabRefs.current[next]?.focus();
  };
  const selectedSummary = page?.groups.find(item => item.group === page.selectedGroup);
  return <ReportSection id="standings" title="Group standings" subtitle="Compare placement and advancement while keeping the full field searchable.">
    <div className="table-toolbar" aria-label="Standings controls">
      <label className="grow">Search <input type="search" placeholder="Pokémon name" autoComplete="off" value={query} onChange={event => { setQuery(event.target.value); resetPage(); }} /></label>
      <label>Rows <select value={limit} onChange={event => { setLimit(Number(event.target.value)); resetPage(); }}>{PAGE_SIZES.map(size => <option key={size}>{size}</option>)}</select></label>
      <output aria-live="polite">{!pending && page ? `${formatNumber(page.total)} matching entrants` : 'Loading…'}</output>
      <Pager page={history.length + 1} total={page?.total || 0} limit={limit} previous={!pending && history.length > 0} next={!pending && Boolean(page?.nextCursor)} onPrevious={previous} onNext={() => next(page?.nextCursor)} />
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {page && <>
      <div className="tabs" role="tablist" aria-label="Tournament groups">{page.groups.map((item, index) => <button key={item.group} ref={node => { tabRefs.current[index] = node; }} id={`standings-tab-${index}`} role="tab" type="button" aria-selected={item.group === page.selectedGroup} aria-controls="standings-panel" tabIndex={item.group === page.selectedGroup ? 0 : -1} onClick={() => selectGroup(item.group)} onKeyDown={event => onTabKey(event, index)}>Group {item.group}</button>)}</div>
      <article id="standings-panel" className="tab-panel" role="tabpanel" aria-labelledby={`standings-tab-${page.groups.findIndex(item => item.group === page.selectedGroup)}`}>
        <div className="section-heading"><h3>Group {page.selectedGroup}</h3><p>{formatNumber(selectedSummary?.completedMatches || 0)} / {formatNumber(selectedSummary?.expectedMatches || 0)} matches · top {formatNumber(page.advancingCount)} advance</p></div>
        <div className="table-wrap large-table-wrap"><table className="data-table primary-sticky"><thead><tr><th>Rank</th><th>Species</th><th>P</th><th>W</th><th>D</th><th>L</th><th>Pts</th><th>Mini pts</th><th>SB</th><th>Tie key</th></tr></thead><tbody>
          {page.items.length === 0 && <EmptyRow columns={10}>No standings match this search.</EmptyRow>}
          {page.items.map(item => <tr key={item.speciesId} className={`${item.rank <= page.advancingCount ? 'advancing' : ''} ${item.rank === page.advancingCount ? 'cutoff-row' : ''}`.trim()}><td>{item.rank}</td><td>{item.species}</td><td>{item.played}</td><td>{item.wins}</td><td>{item.draws}</td><td>{item.losses}</td><td>{item.points}</td><td>{item.miniTablePoints}</td><td>{item.sonnebornBerger}</td><td><code className="truncate" title={item.tieKey}>{item.tieKey}</code></td></tr>)}
        </tbody></table></div>
      </article>
    </>}
    <p className="note">Standings contain every entrant from the validated artifact. Only the selected page is rendered.</p>
  </ReportSection>;
}
