import {useEffect, useRef, useState} from 'react';

// The key binds a page and its cursors to the exact request that produced them.
// Abort plus identity checks protects against transports that ignore cancellation.
export function usePaginatedRequest<T>(key: string,
  load: (signal: AbortSignal) => Promise<T>, onSuccess?: (page: T) => void) {
  const loader = useRef(load);
  const success = useRef(onSuccess);
  const [attempt, setAttempt] = useState(0);
  loader.current = load;
  success.current = onSuccess;
  const [state, setState] = useState<{key: string; attempt: number; page: T | null; loading: boolean; error: string}>(
    {key: '', attempt: 0, page: null, loading: true, error: ''});
  useEffect(() => {
    const controller = new AbortController();
    const invoke = loader.current;
    const onLoaded = success.current;
    setState(current => ({...current, loading: true, error: ''}));
    Promise.resolve().then(() => invoke(controller.signal)).then(page => {
      if (controller.signal.aborted) return;
      setState({key, attempt, page, loading: false, error: ''});
      onLoaded?.(page);
    }, error => {
      if (controller.signal.aborted) return;
      setState({key, attempt, page: null, loading: false,
        error: error instanceof Error ? error.message : 'Request failed.'});
    });
    return () => controller.abort();
  }, [key, attempt]);
  const current = state.key === key && state.attempt === attempt;
  return {page: state.page, pending: state.loading || !current,
    error: current ? state.error : '', retry: () => setAttempt(value => value + 1)};
}

export function usePagination() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);
  return {
    cursor, history,
    resetPage() { setCursor(null); setHistory([]); },
    previous() { const prior = [...history]; setCursor(prior.pop() || null); setHistory(prior); },
    next(nextCursor: string | null | undefined) {
      if (!nextCursor) return;
      setHistory(items => [...items, cursor]); setCursor(nextCursor);
    },
  };
}
