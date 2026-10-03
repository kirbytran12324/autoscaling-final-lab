import {useEffect, useState} from 'react';
import {listRuns, loadRun} from './api';
import {AppHeader, EmptyState, ErrorState, formatDate, formatDuration, LoadingState} from './components';
import ReportView from './ReportView';
import type {Bracket, RunDetail, RunSummary} from './types';
import './styles.css';

function pathRunId(pathname: string) {
  const match = /^\/runs\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function useLocationPath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  const navigate = (next: string) => {
    window.history.pushState({}, '', next);
    setPath(next);
    window.scrollTo({top: 0});
  };
  return {path, navigate};
}

export default function App() {
  const {path, navigate} = useLocationPath();
  const runId = pathRunId(path);
  return runId
    ? <TournamentPage runId={runId} goHome={() => navigate('/')} />
    : <Dashboard openRun={id => navigate(`/runs/${encodeURIComponent(id)}`)} />;
}

function Dashboard({openRun}: {openRun: (id: string) => void}) {
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<
    {kind: 'loading'} | {kind: 'error'; message: string} | {kind: 'ready'; runs: RunSummary[]}
  >({kind: 'loading'});
  useEffect(() => {
    const controller = new AbortController();
    setState({kind: 'loading'});
    listRuns(controller.signal).then(
      runs => setState({kind: 'ready', runs}),
      error => { if (error.name !== 'AbortError') setState({kind: 'error', message: error.message}); }
    );
    return () => controller.abort();
  }, [reload]);
  return <div className="dashboard-shell">
    <AppHeader><span className="read-only-badge">Read only</span></AppHeader>
    <main id="main-content" className="dashboard" tabIndex={-1}>
      <div className="dashboard-hero"><div><p className="eyebrow">Completed-run archive</p><h1>Deterministic battles.<br /><span>Durable results.</span></h1><p>Explore validated tournament outcomes, standings, brackets, and every accepted simulation.</p></div></div>
      <div className="list-heading"><div><p className="eyebrow">Archive</p><h2>Completed tournaments</h2></div>{state.kind === 'ready' && <span>{state.runs.length} runs</span>}</div>
      {state.kind === 'loading' && <LoadingState />}
      {state.kind === 'error' && <ErrorState message={state.message} retry={() => setReload(value => value + 1)} />}
      {state.kind === 'ready' && state.runs.length === 0 && <EmptyState />}
      {state.kind === 'ready' && state.runs.length > 0 && <div className="run-grid">{state.runs.map(run => <RunCard key={run.runId} run={run} open={() => openRun(run.runId)} />)}</div>}
    </main>
    <footer>Canonical artifacts · strict completion validation · no control plane access</footer>
  </div>;
}

function RunCard({run, open}: {run: RunSummary; open: () => void}) {
  return <article className="run-card">
    <div className="run-card-top"><span className="status-dot">Completed</span><span>{run.mode}</span></div>
    <div><p className="mono muted">{run.runId}</p><h3>{run.champion.species}</h3><p className="champion-label">Tournament champion</p></div>
    <dl className="mini-stats"><div><dt>Entrants</dt><dd>{run.entrantCount.toLocaleString()}</dd></div><div><dt>Matches</dt><dd>{run.matchCount.toLocaleString()}</dd></div><div><dt>Duration</dt><dd>{formatDuration(run.startedAt, run.completedAt)}</dd></div></dl>
    <div className="run-card-bottom"><span>{formatDate(run.completedAt)}</span><button className="button open-run" onClick={open} aria-label={`Open ${run.runId}`}>Explore run <span aria-hidden="true">→</span></button></div>
  </article>;
}

function TournamentPage({runId, goHome}: {runId: string; goHome: () => void}) {
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<
    {kind: 'loading'} | {kind: 'error'; message: string} |
    {kind: 'ready'; run: RunDetail; bracket: Bracket}
  >({kind: 'loading'});
  useEffect(() => {
    const controller = new AbortController();
    setState({kind: 'loading'});
    loadRun(runId, controller.signal).then(
      data => setState({kind: 'ready', ...data}),
      error => { if (error.name !== 'AbortError') setState({kind: 'error', message: error.message}); }
    );
    return () => controller.abort();
  }, [runId, reload]);
  if (state.kind !== 'ready') return <div className="dashboard-shell">
    <AppHeader><button className="back-runs" onClick={goHome}>← Back to all runs</button></AppHeader>
    <main id="main-content" className="dashboard" tabIndex={-1}>
      {state.kind === 'loading' ? <LoadingState label={`Loading ${runId}…`} /> :
        <ErrorState message={state.message} retry={() => setReload(value => value + 1)} />}
    </main>
  </div>;
  return <ReportView {...state} goHome={goHome} />;
}
