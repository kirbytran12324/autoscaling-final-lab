import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import App from './App';
import type {ControlRun} from './control-api';

beforeEach(() => {
  vi.stubGlobal('localStorage', {setItem: vi.fn()});
  vi.stubGlobal('sessionStorage', {setItem: vi.fn()});
  window.history.replaceState({}, '', '/operate');
  window.METRONOME_CONFIG = {...window.METRONOME_CONFIG, controlEnabled: true};
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.METRONOME_CONFIG!.controlEnabled = false; });
const json = (body: object, status = 200) => new Response(JSON.stringify(body), {status});
const run: ControlRun = {runId: 'sample-demo', mode: 'sample', seed: 'seed', concurrency: 2,
  createdAt: '2026-10-09T00:00:00Z', phase: 'running', archiveReady: false,
  progress: {acceptedResultCount: 12, stage: 'groups', round: null, updatedAt: '2026-10-09T00:00:00Z'}};

test('controls require unlock, create validated fields, poll progress, pause, and keep token out of storage', async () => {
  const requests: {url: string; options?: RequestInit}[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    requests.push({url: String(url), options});
    if (String(url).endsWith('/options')) return json({maxConcurrency: 8});
    if (String(url).endsWith('/pause')) return json({run: {...run, phase: 'pausing'}});
    if (String(url).endsWith('/logs')) return json({logs: 'Accepted battle group-A-000001'});
    if (String(url).endsWith('/runs')) return options?.method === 'POST' ? json({run}, 202) : json({runs: [run]});
    return json({run});
  });
  render(<App />);
  expect(screen.queryByRole('button', {name: 'Create tournament'})).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Operator token'), {target: {value: 'a'.repeat(32)}});
  fireEvent.click(screen.getByRole('button', {name: 'Unlock controls'}));
  await screen.findByRole('button', {name: 'Create tournament'});
  fireEvent.change(screen.getByLabelText('Run ID'), {target: {value: 'sample-demo'}});
  fireEvent.change(screen.getByLabelText('Seed'), {target: {value: 'seed'}});
  fireEvent.click(screen.getByRole('button', {name: 'Create tournament'}));
  expect(await screen.findByText('12')).toBeInTheDocument();
  expect(await screen.findByText('Accepted battle group-A-000001')).toBeInTheDocument();
  const create = requests.find(item => item.url.endsWith('/runs') && item.options?.method === 'POST');
  expect(JSON.parse(String(create?.options?.body))).toEqual({runId: 'sample-demo', mode: 'sample', seed: 'seed', concurrency: 2});
  fireEvent.click(screen.getByRole('button', {name: 'Pause'}));
  await waitFor(() => expect(requests.some(item => item.url.endsWith('/pause'))).toBe(true));
  expect(localStorage.setItem).not.toHaveBeenCalled(); expect(sessionStorage.setItem).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', {name: 'Lock controls'}));
  expect(screen.getByLabelText('Operator token')).toHaveValue('');
});

test('failed authentication shows server error without enabling creation', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({error: {code: 'UNAUTHORIZED', message: 'Enter a valid operator token.'}}, 401));
  render(<App />);
  fireEvent.change(screen.getByLabelText('Operator token'), {target: {value: 'wrong'}});
  fireEvent.click(screen.getByRole('button', {name: 'Unlock controls'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid operator token');
  expect(screen.queryByRole('button', {name: 'Create tournament'})).not.toBeInTheDocument();
});

test('archive-only deployment explains disabled controls and performs no control request', () => {
  window.METRONOME_CONFIG!.controlEnabled = false;
  const request = vi.spyOn(globalThis, 'fetch'); render(<App />);
  expect(screen.getByText('Run controls have not been enabled for this deployment.')).toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});

test('an action completing after another run is selected cannot replace its details or logs', async () => {
  window.history.replaceState({}, '', '/operate/runs/sample-demo');
  const other = {...run, runId: 'other-run', phase: 'completed' as const};
  let finishPause!: (response: Response) => void;
  let finishOther!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    if (path.endsWith('/options')) return json({maxConcurrency: 8});
    if (path.endsWith('/pause')) return new Promise(resolve => {finishPause = resolve;});
    if (path.endsWith('/runs')) return json({runs: [run, other]});
    if (path.endsWith('/logs')) return json({logs: path.includes('other-run') ? 'other logs' : 'sample logs'});
    if (path.endsWith('/other-run')) return new Promise(resolve => {finishOther = resolve;});
    return json({run});
  });
  render(<App />);
  fireEvent.change(screen.getByLabelText('Operator token'), {target: {value: 'a'.repeat(32)}});
  fireEvent.click(screen.getByRole('button', {name: 'Unlock controls'}));
  await screen.findByRole('heading', {name: run.runId});
  fireEvent.click(screen.getByRole('button', {name: 'Pause'}));
  fireEvent.click(screen.getByRole('button', {name: /^other-run/}));
  await act(async () => finishPause(json({run: {...run, phase: 'pausing'}})));
  await waitFor(() => expect(finishOther).toBeTypeOf('function'));
  expect(window.location.pathname).toBe('/operate/runs/other-run');
  expect(screen.queryByRole('heading', {name: run.runId})).not.toBeInTheDocument();
  await act(async () => finishOther(json({run: other})));
  expect(screen.getByRole('heading', {name: other.runId})).toBeInTheDocument();
  expect(screen.getByLabelText('Recent logs')).toHaveTextContent('other logs');
});

test('a poll started before a mutation cannot undo the accepted action response', async () => {
  vi.useFakeTimers();
  window.history.replaceState({}, '', '/operate/runs/sample-demo');
  let statusReads = 0;
  let phase: ControlRun['phase'] = 'running';
  let finishOldPoll!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    if (path.endsWith('/options')) return json({maxConcurrency: 8});
    if (path.endsWith('/pause')) {phase = 'pausing'; return json({run: {...run, phase}});}
    if (path.endsWith('/runs')) return json({runs: [run]});
    if (path.endsWith('/logs')) return json({logs: 'sample logs'});
    statusReads++;
    if (statusReads === 2) return new Promise(resolve => {finishOldPoll = resolve;});
    return json({run: {...run, phase}});
  });
  await act(async () => {render(<App />);});
  fireEvent.change(screen.getByLabelText('Operator token'), {target: {value: 'a'.repeat(32)}});
  await act(async () => {fireEvent.click(screen.getByRole('button', {name: 'Unlock controls'}));});
  expect(screen.getByRole('heading', {name: run.runId})).toBeInTheDocument();
  await act(async () => {await vi.advanceTimersByTimeAsync(3000);});
  expect(finishOldPoll).toBeTypeOf('function');
  await act(async () => {fireEvent.click(screen.getByRole('button', {name: 'Pause'}));});
  expect(screen.getByRole('status')).toHaveTextContent('Pausing');
  await act(async () => finishOldPoll(json({run: {...run, phase: 'running'}})));
  expect(screen.getByRole('status')).toHaveTextContent('Pausing');
  expect(screen.queryByRole('button', {name: 'Pause'})).not.toBeInTheDocument();
});

test('missing graphics configuration preserves active controls and saved standings', async () => {
  const config = window.METRONOME_CONFIG;
  window.METRONOME_CONFIG = {controlEnabled: true};
  window.history.replaceState({}, '', '/operate/runs/sample-demo');
  const snapshot = {standings: {status: 'preliminary', updatedAt: run.createdAt,
    groups: [{group: 'A', standings: [{species: 'Snorlax', speciesId: 'snorlax', rank: 1, played: 1, points: 3}]}]}};
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    if (path.endsWith('/options')) return json({maxConcurrency: 8});
    if (path.endsWith('/runs')) return json({runs: [run]});
    if (path.endsWith('/logs')) return json({logs: 'saved logs'});
    return json({run: {...run, snapshot}});
  });
  try {
    render(<App />);
    fireEvent.change(screen.getByLabelText('Operator token'), {target: {value: 'a'.repeat(32)}});
    fireEvent.click(screen.getByRole('button', {name: 'Unlock controls'}));
    expect(await screen.findByRole('button', {name: 'Pause'})).toBeEnabled();
    expect(screen.getByText('Snorlax')).toBeInTheDocument();
    expect(screen.getByText(/Configure/)).toHaveTextContent('showdownAssetBaseUrl');
    expect(screen.getByLabelText('Recent logs')).toHaveTextContent('saved logs');
    expect(document.querySelector('img')).not.toBeInTheDocument();
  } finally {window.METRONOME_CONFIG = config;}
});
