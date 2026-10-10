import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import App from './App';
import type {ControlRun} from './control-api';

beforeEach(() => {
  vi.stubGlobal('localStorage', {setItem: vi.fn()});
  vi.stubGlobal('sessionStorage', {setItem: vi.fn()});
  window.history.replaceState({}, '', '/operate');
  window.METRONOME_CONFIG = {...window.METRONOME_CONFIG, controlEnabled: true};
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.METRONOME_CONFIG!.controlEnabled = false; });
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
