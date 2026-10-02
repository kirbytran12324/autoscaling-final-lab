import {usePaginatedRequest, usePagination} from '../usePaginatedRequest';
import {useState} from 'react';
import {listMatches} from '../api';
import {formatNumber, matchOutcome} from '../formatters';
import type {Match, MatchSort, RunDetail, SortDirection} from '../types';
import {ReportSection, Pager, EmptyRow, DetailPair} from './shared';
import {PAGE_SIZES} from './constants';

export function BattleExplorer({run}: {run: RunDetail}) {
  const [filters, setFilters] = useState<MatchFilters>({query: '', stage: '', result: '', hostname: ''});
  const [limit, setLimit] = useState(25);
  const [sort, setSort] = useState<MatchSort>('matchId');
  const [direction, setDirection] = useState<SortDirection>('asc');
  const {cursor, history, resetPage, previous, next} = usePagination();
  const [selected, setSelected] = useState<Match | null>(null);
  const requestKey = JSON.stringify([run.runId, filters, limit, sort, direction, cursor]);
  const {page, pending, error} = usePaginatedRequest(requestKey,
    signal => listMatches(run.runId, {...filters, limit, sort, direction, cursor}, signal));
  const updateFilter = (name: keyof MatchFilters, value: string) => { setFilters(current => ({...current, [name]: value})); resetPage(); };
  const reset = () => { setFilters({query: '', stage: '', result: '', hostname: ''}); setSort('matchId'); setDirection('asc'); resetPage(); };
  const sortBy = (next: MatchSort) => { if (sort === next) setDirection(value => value === 'asc' ? 'desc' : 'asc'); else { setSort(next); setDirection('asc'); } resetPage(); };
  const columns: [MatchSort, string][] = [['matchId', 'Match ID'], ['stage', 'Stage'], ['matchup', 'Matchup'], ['result', 'Result'], ['winner', 'Winner'], ['turns', 'Turns']];
  return <ReportSection id="simulations" title="Battle explorer" subtitle="Filter accepted battles, then select a row to inspect its complete record.">
    <details id="simulation-explorer" className="disclosure"><summary>Search and browse {formatNumber(run.matchCount)} accepted simulations</summary>
      <div className="table-toolbar" aria-label="Battle explorer controls">
        <label className="grow">Search <input type="search" placeholder="Match ID or species" autoComplete="off" value={filters.query} onChange={event => updateFilter('query', event.target.value)} /></label>
        <label>Stage <select value={filters.stage} onChange={event => updateFilter('stage', event.target.value)}><option value="">All</option>{run.report.matchFacets.stages.filter(stage => stage !== 'Unknown').map(stage => <option key={stage}>{stage}</option>)}</select></label>
        <label>Result <select value={filters.result} onChange={event => updateFilter('result', event.target.value)}><option value="">All</option><option value="win">Win</option><option value="tie">Tie</option></select></label>
        <label>Reported hostname <select value={filters.hostname} onChange={event => updateFilter('hostname', event.target.value)}><option value="">All</option>{run.report.matchFacets.hostnames.map(hostname => <option key={hostname}>{hostname}</option>)}</select></label>
        <label>Rows <select value={limit} onChange={event => { setLimit(Number(event.target.value)); resetPage(); }}>{PAGE_SIZES.map(size => <option key={size}>{size}</option>)}</select></label>
        <button type="button" onClick={reset}>Reset filters</button>
        <output aria-live="polite">{!pending && page ? `${formatNumber(page.total)} matching battles` : 'Loading…'}</output>
        <Pager page={history.length + 1} total={page?.total || 0} limit={limit} previous={!pending && history.length > 0} next={!pending && Boolean(page?.nextCursor)} onPrevious={previous} onNext={() => next(page?.nextCursor)} />
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="explorer-layout"><div className="table-wrap large-table-wrap"><table id="simulation-table" className="data-table primary-sticky selectable-table"><thead><tr>{columns.map(([key, label]) => <th key={key} aria-sort={sort === key ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}><button type="button" className="sort-button" onClick={() => sortBy(key)}>{label}<span aria-hidden="true">{sort === key ? direction === 'asc' ? ' ↑' : ' ↓' : ''}</span></button></th>)}</tr></thead><tbody>
        {page?.items.length === 0 && <EmptyRow columns={6}>No accepted battles match these filters.</EmptyRow>}
        {page?.items.map(match => { const outcome = matchOutcome(match); return <tr key={match.matchId} tabIndex={0} aria-selected={selected?.matchId === match.matchId} aria-label={`Open details for ${match.matchId}`} onClick={() => setSelected(match)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(match); } }}><td><code className="truncate" title={match.matchId}>{match.matchId}</code></td><td>{match.stage}</td><td>{match.pokemon1} vs {match.pokemon2}</td><td>{outcome.result}</td><td>{outcome.winner}</td><td>{match.turns}</td></tr>; })}
      </tbody></table></div><MatchDetail match={selected} /></div>
      <p className="note">Only the selected page is rendered. Filtering, sorting, and pagination are applied by the read-only API to the complete accepted set.</p>
    </details>
  </ReportSection>;
}

export function MatchDetail({match}: {match: Match | null}) {
  if (!match) return <aside id="sim-detail" className="record-detail" aria-live="polite"><p>Select a battle to view the complete accepted record.</p></aside>;
  const outcome = matchOutcome(match);
  return <aside id="sim-detail" className="record-detail" aria-live="polite"><h3>Battle {match.matchId}</h3><dl>
    <DetailPair label="Stage" value={match.stage} /><DetailPair label="Group" value={match.group} /><DetailPair label="Round" value={match.round} />
    <DetailPair label="Participant 1" value={match.pokemon1} /><DetailPair label="Participant 2" value={match.pokemon2} /><DetailPair label="Outcome" value={outcome.result} />
    <DetailPair label="Winner side" value={match.winnerSide} /><DetailPair label="Winner" value={outcome.winner} /><DetailPair label="Turns" value={match.turns} />
    <DetailPair label="Termination" value={match.termination} /><DetailPair label="Reported hostname" value={match.servedBy} copy /><DetailPair label="Duration (ms)" value={match.durationMs} />
    <DetailPair label="Seed" value={match.seed.join(', ')} copy /><DetailPair label="Simulator version" value={match.simulatorVersion} /><DetailPair label="Protocol hash" value={match.protocolHash} copy />
  </dl><div className="replay-pending"><button type="button" disabled>Watch replay</button><span>Replay support is not implemented yet.</span></div></aside>;
}

export interface MatchFilters {query: string; stage: string; result: string; hostname: string}
