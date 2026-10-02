import type {
  Bracket, MatchPage, MatchSort, RunDetail, RunSummary, SortDirection, StandingsPage,
} from './types';

interface ErrorPayload {error?: {code?: string; message?: string}}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {headers: {accept: 'application/json'}, signal});
  if (!response.ok) {
    let payload: ErrorPayload = {};
    try { payload = await response.json() as ErrorPayload; } catch { /* safe fallback */ }
    throw new Error(payload.error?.message || `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

export async function listRuns(signal?: AbortSignal): Promise<RunSummary[]> {
  return (await getJson<{runs: RunSummary[]}>('/api/runs', signal)).runs;
}

export async function loadRun(runId: string, signal?: AbortSignal) {
  const base = `/api/runs/${encodeURIComponent(runId)}`;
  const [run, bracket] = await Promise.all([
    getJson<{run: RunDetail}>(base, signal),
    getJson<{bracket: Bracket}>(`${base}/bracket`, signal),
  ]);
  return {run: run.run, bracket: bracket.bracket};
}

export async function listStandings(runId: string, options: {
  group: string; query: string; limit: number; cursor?: string | null;
}, signal?: AbortSignal): Promise<StandingsPage> {
  const parameters = new URLSearchParams({
    group: options.group,
    q: options.query,
    limit: String(options.limit),
  });
  if (options.cursor) parameters.set('cursor', options.cursor);
  return (await getJson<{standings: StandingsPage}>(
    `/api/runs/${encodeURIComponent(runId)}/standings?${parameters}`,
    signal
  )).standings;
}

export async function listMatches(runId: string, options: {
  cursor?: string | null;
  limit: number;
  query: string;
  stage: string;
  result: string;
  hostname: string;
  sort: MatchSort;
  direction: SortDirection;
}, signal?: AbortSignal): Promise<MatchPage> {
  const parameters = new URLSearchParams({
    limit: String(options.limit),
    sort: options.sort,
    direction: options.direction,
  });
  for (const [key, value] of Object.entries({
    q: options.query,
    stage: options.stage,
    result: options.result,
    hostname: options.hostname,
  })) if (value) parameters.set(key, value);
  if (options.cursor) parameters.set('cursor', options.cursor);
  return getJson<MatchPage>(
    `/api/runs/${encodeURIComponent(runId)}/matches?${parameters}`,
    signal
  );
}
