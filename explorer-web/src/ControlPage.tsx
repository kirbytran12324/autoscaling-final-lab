import {useEffect, useRef, useState} from 'react';
import {AppHeader} from './components';
import {ApiRequestError} from './api';
import {controlRequest, managedLogout, safeOperatorPath} from './control-api';
import type {ControlRun, ControlSession, RunInput} from './control-api';
import {RunProgress} from './RunProgress';
import {ShowdownAssetsWarning} from './ShowdownAssetsWarning';
import './styles-control.css';

const labels = {pending: 'Waiting to start', running: 'Running', pausing: 'Pausing', paused: 'Paused',
  resuming: 'Resuming', publishing: 'Tournament finished · archiving', 'publication-failed': 'Archive publication failed',
  failed: 'Runner failed', completed: 'Archive ready'};

export default function ControlPage({goHome, openArchive}: {goHome: () => void; openArchive: (id: string) => void}) {
  const managed = window.METRONOME_CONFIG?.controlAuthMode === 'alb';
  const [session, setSession] = useState<'loading' | 'operator' | 'unauthenticated' | 'expired' | 'forbidden' | 'unavailable'>('loading');
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [credential, setCredential] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(16);
  const [input, setInput] = useState<RunInput>(() => {
    try {
      const draft = JSON.parse(sessionStorage.getItem('operator-draft') || 'null');
      if (draft && typeof draft.runId === 'string' && draft.runId.length <= 40 &&
          typeof draft.seed === 'string' && draft.seed.length <= 128 && ['sample', 'full'].includes(draft.mode) &&
          Number.isInteger(draft.concurrency) && draft.concurrency >= 1 && draft.concurrency <= 64) {
        return {runId: draft.runId, seed: draft.seed, mode: draft.mode, concurrency: draft.concurrency};
      }
    } catch { /* Storage is optional; credentials are never stored. */ }
    return {runId: '', mode: 'sample', seed: '', concurrency: 2};
  });
  const [runs, setRuns] = useState<ControlRun[]>([]);
  const [selected, setSelected] = useState(() => /^\/operate\/runs\/([a-z0-9-]{1,40})\/?$/.exec(window.location.pathname)?.[1] || '');
  const [run, setRun] = useState<ControlRun | null>(null);
  const [logs, setLogs] = useState('');
  const [follow, setFollow] = useState(true);
  const logElement = useRef<HTMLPreElement>(null);
  // Selection changes and mutations invalidate every older read or action result.
  const requestVersion = useRef(0);
  const mounted = useRef(false);
  const authorized = managed ? session === 'operator' : Boolean(token);

  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false; requestVersion.current++;};
  }, []);
  const isCurrent = (version: number) => mounted.current && requestVersion.current === version;

  function failureState(failure: unknown) {
    setError(failure instanceof Error ? failure.message : 'Control service is unavailable.');
    if (failure instanceof ApiRequestError && failure.status === 401) {
      setToken(''); setCredential('');
      setSession(previous => previous === 'operator' ? 'expired' : 'unauthenticated');
    } else if (failure instanceof ApiRequestError && failure.status === 403 &&
        !['CSRF_REJECTED', 'INVALID_ORIGIN'].includes(failure.code)) {
      setSession('forbidden');
    } else if (managed && (!(failure instanceof ApiRequestError) || failure.status >= 500)) {
      setSession('unavailable');
    }
  }
  useEffect(() => {
    if (!managed || !window.METRONOME_CONFIG?.controlEnabled) return;
    const controller = new AbortController();
    setSession('loading'); setError('');
    controlRequest<ControlSession>('session', '', {signal: controller.signal}).then(result => {
      if (controller.signal.aborted) return;
      if (result.mode !== 'alb' || result.operator !== true) {setSession('unavailable'); return;}
      setLimit(result.maxConcurrency); setSession('operator');
    }, failure => {if (!controller.signal.aborted) failureState(failure);});
    return () => controller.abort();
  }, [managed, sessionAttempt]);

  function rememberDraft() {
    try { sessionStorage.setItem('operator-draft', JSON.stringify(input)); } catch { /* optional */ }
  }
  function selectRun(id: string) {
    requestVersion.current++;
    setSelected(id);
    window.history.replaceState({}, '', safeOperatorPath(`/operate/runs/${id}`));
  }
  async function signOut() {
    setBusy(true); setError('');
    try {
      const destination = await managedLogout();
      try { sessionStorage.removeItem('operator-draft'); } catch { /* optional */ }
      window.location.assign(destination);
    } catch (failure) {setError(failure instanceof Error ? failure.message : 'Sign out failed.');}
    finally {setBusy(false);}
  }

  useEffect(() => {
    if (!authorized || busy) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function refresh() {
      const version = requestVersion.current;
      try {
        const options = {signal: controller.signal};
        const result = await controlRequest<{runs: ControlRun[]}>('runs', token, options);
        if (stopped || !isCurrent(version)) return;
        setRuns(result.runs);
        if (selected) {
          const [status, log] = await Promise.all([
            controlRequest<{run: ControlRun}>(`runs/${selected}`, token, options),
            controlRequest<{logs: string}>(`runs/${selected}/logs`, token, options),
          ]);
          if (stopped || !isCurrent(version)) return;
          setRun(status.run); setLogs(log.logs);
        }
        setError('');
      } catch (failure) {
        if (stopped || !isCurrent(version)) return;
        failureState(failure);
      } finally { if (!stopped) timer = setTimeout(refresh, 3000); }
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [authorized, token, selected, busy]);
  useEffect(() => { if (follow) logElement.current?.scrollTo?.({top: logElement.current.scrollHeight}); }, [logs, follow]);

  async function unlock() {
    setBusy(true); setError('');
    try {
      const result = await controlRequest<{maxConcurrency: number}>('options', credential);
      setLimit(result.maxConcurrency); setToken(credential); setCredential('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not unlock controls.'); }
    finally { setBusy(false); }
  }
  async function create() {
    const version = ++requestVersion.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await controlRequest<{run: ControlRun}>('runs', token, {method: 'POST', body: input});
      if (!isCurrent(version)) return;
      setRun(result.run); selectRun(result.run.runId); setLogs('');
    } catch (failure) { if (isCurrent(version)) failureState(failure); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function action(name: string) {
    if (!run) return;
    const version = ++requestVersion.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await controlRequest<{run: ControlRun}>(`runs/${run.runId}/${name}`, token, {method: 'POST'});
      if (!isCurrent(version)) return;
      setRun(result.run);
      if (name === 'release-failed') setNotice('Runner slot release requested. Saved tournament evidence is retained.');
    } catch (failure) { if (isCurrent(version)) failureState(failure); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <div className="dashboard-shell"><AppHeader><button className="back-runs" onClick={goHome}>← Completed tournaments</button></AppHeader>
    <main className="dashboard control-page" id="main-content" tabIndex={-1}><h1>Run a tournament</h1>
      <ShowdownAssetsWarning />
      {!window.METRONOME_CONFIG?.controlEnabled ? <p>Run controls have not been enabled for this deployment.</p> : <>
        {error && <p role="alert" className="inline-error">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {managed && <button disabled={busy} onClick={() => void signOut()}>Sign out</button>}
        {managed && !authorized && <section aria-label="Operator session">
          {session === 'loading' && <p role="status">Checking operator session…</p>}
          {session === 'unauthenticated' && <p>Sign in to use operator controls.</p>}
          {session === 'expired' && <p>Your session expired. Sign in again. Your last operation will not be retried automatically.</p>}
          {session === 'forbidden' && <p>This account is not an approved operator. Sign out to use another account.</p>}
          {session === 'unavailable' && <><p>Operator session service is unavailable.</p><button onClick={() => setSessionAttempt(value => value + 1)}>Retry session check</button></>}
          {['unauthenticated', 'expired'].includes(session) && <a href={safeOperatorPath(window.location.pathname)} onClick={rememberDraft}>Sign in</a>}
        </section>}
        {!authorized && !managed ? <form onSubmit={event => { event.preventDefault(); void unlock(); }}>
          <p>Enter the operator token to create and manage tournaments. It is kept in memory until you lock controls or leave the page.</p>
          <label>Operator token <input type="password" required autoComplete="off" value={credential} onChange={event => setCredential(event.target.value)} /></label>
          <button disabled={busy}>Unlock controls</button>
        </form> : authorized ? <>
          {!managed && <button onClick={() => {requestVersion.current++; setToken(''); setCredential(''); setRun(null); setSelected(''); setRuns([]); setLogs('');}}>Lock controls</button>}
          <form className="run-form" onSubmit={event => {event.preventDefault(); void create();}}>
            <label>Run ID <input required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={40} value={input.runId}
              placeholder="friday-sample-001" onChange={event => setInput({...input, runId: event.target.value})} /></label>
            <label>Tournament type <select value={input.mode} onChange={event => setInput({...input, mode: event.target.value as RunInput['mode']})}>
              <option value="sample">Sample · 32 Pokémon</option><option value="full">Full · 1,025 Pokémon</option></select></label>
            <label>Seed <input required maxLength={128} value={input.seed} onChange={event => setInput({...input, seed: event.target.value})} /></label>
            <label>Concurrent battles <input type="number" required min={1} max={limit} value={input.concurrency}
              onChange={event => setInput({...input, concurrency: Number(event.target.value)})} /></label>
            <p>One tournament runs at a time. Full tournaments can take substantially longer.</p>
            <button disabled={busy}>Create tournament</button>
          </form>
          <section><h2>Tournament runs</h2><ul className="control-runs">{runs.map(item => <li key={item.runId}>
              <button onClick={() => {selectRun(item.runId); setRun(null); setLogs('');}}>{item.runId} · {labels[item.phase]}</button>
          </li>)}</ul></section>
          {run && <section><h2>{run.runId}</h2><p role="status">{labels[run.phase]}</p>
            {run.error && <p role="alert">{run.error}</p>}
            <div className="control-actions">
              {['running', 'pending', 'resuming'].includes(run.phase) && <button disabled={busy} onClick={() => void action('pause')}>Pause</button>}
              {run.phase === 'paused' && <button disabled={busy} onClick={() => void action('resume')}>Resume</button>}
              {run.phase === 'publication-failed' && <button disabled={busy} onClick={() => void action('retry-publication')}>Retry archive publication</button>}
              {run.phase === 'failed' && <button disabled={busy} onClick={() => void action('release-failed')}>Release runner slot · keep saved evidence</button>}
              {run.archiveReady && <button onClick={() => openArchive(run.runId)}>Explore completed run</button>}
            </div>
            <RunProgress run={run} />
            <h3>Recent runner and publisher logs</h3><label><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /> Follow logs</label>
            <pre ref={logElement} className="control-logs" aria-label="Recent logs">{logs || 'Waiting for logs…'}</pre>
          </section>}
        </> : null}
      </>}
    </main></div>;
}
