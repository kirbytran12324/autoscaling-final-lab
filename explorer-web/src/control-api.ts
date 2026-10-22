import {ApiRequestError} from './api';
import type {Entrant} from './types';

export interface RunInput {runId: string; mode: 'sample' | 'full'; seed: string; concurrency: number}
export type RunPhase = 'pending' | 'running' | 'pausing' | 'paused' | 'resuming' |
  'publishing' | 'publication-failed' | 'failed' | 'completed';
export interface ControlRun extends RunInput {
  phase: RunPhase; createdAt: string; archiveReady: boolean; error?: string | null;
  progress?: {stage: string; round: string | null; acceptedResultCount: number; updatedAt: string} | null;
  snapshot?: {
    standings?: {status: string; updatedAt: string; groups: {group: string; standings:
      {species: string; speciesId: string; rank: number; played: number; points: number}[]}[]} | null;
    bracket?: {status: string; rounds: {round: string; series: {seriesId: string;
      entrant1: Entrant; entrant2: Entrant; evaluation?: {winner?: Entrant; entrant1Wins?: number; entrant2Wins?: number}}[]}[]} | null;
    events?: {at: string; type: string; matchId?: string; pokemon1?: string; pokemon2?: string; outcome?: string; turns?: number}[];
  } | null;
}

export async function controlRequest<T>(path: string, token: string,
  {method = 'GET', body, signal}: {method?: string; body?: object; signal?: AbortSignal} = {}): Promise<T> {
  const managed = window.METRONOME_CONFIG?.controlAuthMode === 'alb';
  const response = await fetch(`/api/control/${path}`, {method, signal, credentials: 'same-origin', redirect: 'error',
    headers: {accept: 'application/json', ...(!managed ? {authorization: `Bearer ${token}`} : {}),
      ...(managed && method !== 'GET' ? {'x-control-csrf': '1'} : {}),
      ...(body ? {'content-type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
  if (!response.ok) {
    let error: {code?: string; message?: string} = {};
    try { error = (await response.json()).error || {}; } catch { /* safe fallback */ }
    throw new ApiRequestError(error.message || `Control request failed (${response.status}).`,
      error.code || 'CONTROL_UNAVAILABLE', response.status);
  }
  return response.json() as Promise<T>;
}

export interface ControlSession {mode: 'alb' | 'bearer'; subject?: string; operator: true; maxConcurrency: number}

// Only canonical operator pages are valid login return destinations. Queries,
// external URLs, encoded separators and archive routes are never carried over.
export function safeOperatorPath(path: string) {
  return /^\/operate(?:\/runs\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)?\/?$/.test(path) ? path : '/operate';
}

export async function managedLogout(): Promise<string> {
  const response = await fetch('/auth/logout', {method: 'POST', credentials: 'same-origin', redirect: 'error',
    headers: {'x-control-csrf': '1', accept: 'application/json'}});
  if (!response.ok) throw new Error(`Sign out failed (${response.status}). Try again.`);
  const {logoutUrl} = await response.json();
  const url = new URL(logoutUrl);
  if (url.protocol !== 'https:' || url.pathname !== '/logout' || url.username || url.password) throw new Error('Invalid sign-out destination.');
  return url.href;
}
