import {useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {ApiRequestError, loadReplay} from './api';
import type {Match, VerifiedReplay} from './types';

type ReplayState = {kind: 'loading'} | {kind: 'error'; message: string; retryable: boolean} |
  {kind: 'ready'; replay: VerifiedReplay};

export default function ReplayDialog({runId, match, onClose}: {
  runId: string; match: Match; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ReplayState>({kind: 'loading'});
  const [playerError, setPlayerError] = useState('');
  const [playerHeight, setPlayerHeight] = useState(520);
  const playerLoaded = useRef(false);
  const replayId = useMemo(() => crypto.randomUUID(), [runId, match.matchId, attempt]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    closeButton.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({kind: 'loading'});
    setPlayerError('');
    playerLoaded.current = false;
    loadReplay(runId, match.matchId, controller.signal).then(replay => {
      if (!controller.signal.aborted) setState({kind: 'ready', replay});
    }, error => {
      if (!controller.signal.aborted) setState({kind: 'error', message: error.message,
        retryable: !(error instanceof ApiRequestError && [409, 422].includes(error.status))});
    });
    return () => controller.abort();
  }, [runId, match.matchId, attempt]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow ||
          event.data?.replayId !== replayId) return;
      if (event.data.type === 'metronome-replay:ready' && state.kind === 'ready') {
        frame.current?.contentWindow?.postMessage({type: 'metronome-replay:init', replayId,
          replay: state.replay,
          assetBaseUrl: import.meta.env.VITE_SHOWDOWN_ASSET_BASE_URL || 'https://play.pokemonshowdown.com/'},
        window.location.origin);
      } else if (event.data.type === 'metronome-replay:escape') onClose();
      else if (event.data.type === 'metronome-replay:loaded') playerLoaded.current = true;
      else if (event.data.type === 'metronome-replay:resize' &&
          Number.isFinite(event.data.height) && event.data.height >= 360 && event.data.height <= 1400) {
        setPlayerHeight(event.data.height);
      }
      else if (event.data.type === 'metronome-replay:error') {
        setPlayerError('The battle player could not load. You can retry or read the verified battle log below.');
      }
    };
    window.addEventListener('message', receive);
    const timeout = state.kind === 'ready' ? window.setTimeout(() => {
      if (!playerLoaded.current) setPlayerError('The battle player did not finish loading. Retry or read the verified log below.');
    }, 15000) : undefined;
    return () => {window.removeEventListener('message', receive); window.clearTimeout(timeout);};
  }, [state, replayId, onClose]);

  return createPortal(<dialog ref={dialog} className="replay-dialog" aria-labelledby="replay-title"
    onCancel={event => {event.preventDefault(); onClose();}}
    onClick={event => {if (event.target === event.currentTarget) onClose();}}>
    <header className="replay-dialog-header"><div><p className="eyebrow">Battle replay</p>
      <h2 id="replay-title">{match.pokemon1} vs {match.pokemon2}</h2>
      <p className="muted mono">{match.matchId}</p></div>
      <button ref={closeButton} type="button" onClick={onClose} aria-label="Close replay">Close ×</button>
    </header>
    {state.kind === 'loading' && <p className="replay-state" role="status">Recreating and verifying the battle…</p>}
    {state.kind === 'error' && <div className="replay-state"><p className="inline-error" role="alert">{state.message}</p>
      {state.retryable && <button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button>}</div>}
    {state.kind === 'ready' && <>
      <div className="replay-verification"><span className="status-dot">Verified against the saved result</span>
        <span>{match.turns} turns · {match.termination === 'turn-cap' ? 'Draw at the 100-turn cap' : 'Natural finish'}</span></div>
      {playerError && <div className="replay-state"><p className="inline-error" role="alert">{playerError}</p>
        <button type="button" onClick={() => setAttempt(value => value + 1)}>Reload player</button></div>}
      <iframe ref={frame} key={replayId} className="replay-frame"
        src={`/showdown/player.html?replayId=${encodeURIComponent(replayId)}&assetBaseUrl=${encodeURIComponent(import.meta.env.VITE_SHOWDOWN_ASSET_BASE_URL || 'https://play.pokemonshowdown.com/')}`}
        title={`Battle replay: ${match.pokemon1} vs ${match.pokemon2}`}
        onLoad={() => frame.current?.contentWindow?.postMessage({type: 'metronome-replay:ping', replayId}, window.location.origin)}
        sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer"
        style={{height: playerHeight}}
        onError={() => setPlayerError('The battle player could not load. Read the verified log below.')} />
      <details className="replay-log-fallback"><summary>Verified battle log and protocol hash</summary>
        <p className="mono">{state.replay.protocolHash}</p><pre>{state.replay.log}</pre></details>
    </>}
  </dialog>, document.body);
}
