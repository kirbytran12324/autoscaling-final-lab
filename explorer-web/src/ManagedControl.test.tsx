import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import App from './App';
import {controlRequest, managedLogout, safeOperatorPath} from './control-api';

const json = (body: object, status = 200) => new Response(JSON.stringify(body), {status});
const session = {mode: 'alb', subject: 'operator', operator: true, maxConcurrency: 8};
beforeEach(() => {
  window.history.replaceState({}, '', '/operate');
  window.METRONOME_CONFIG = {...window.METRONOME_CONFIG, controlEnabled: true, controlAuthMode: 'alb'};
  sessionStorage.clear();
});
afterEach(() => {cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); window.METRONOME_CONFIG!.controlAuthMode = 'bearer'; window.METRONOME_CONFIG!.controlEnabled = false;});

test('managed session enables controls without a credential and never starts a run on login', async () => {
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
    String(url).endsWith('/session') ? json(session) : json({runs: []}));
  render(<App />);
  await screen.findByRole('button', {name: 'Create tournament'});
  expect(screen.queryByLabelText('Operator token')).not.toBeInTheDocument();
  expect(request.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  expect(request.mock.calls.every(([, init]) => !('authorization' in (init!.headers as Record<string, string>)))).toBe(true);
});

test.each([401, 403, 503])('session failure %s has a distinct action and never redirects automatically', async status => {
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({error: {message: 'Session failed'}}, status));
  render(<App />);
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', {name: 'Create tournament'})).not.toBeInTheDocument();
  if (status === 401) expect(screen.getByRole('link', {name: 'Sign in'})).toHaveAttribute('href', '/operate');
  if (status === 403) {expect(screen.getByText(/not an approved operator/)).toBeInTheDocument(); expect(screen.queryByRole('link', {name: 'Sign in'})).not.toBeInTheDocument();}
  if (status === 503) expect(screen.getByRole('button', {name: 'Retry session check'})).toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(1);
});

test('expired mutation is never replayed; explicit sign-in preserves only unfinished fields', async () => {
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/session')) return json(session);
    if (init?.method === 'POST') return json({error: {message: 'Session expired'}}, 401);
    return json({runs: []});
  });
  const view = render(<App />);
  await screen.findByRole('button', {name: 'Create tournament'});
  fireEvent.change(screen.getByLabelText('Run ID'), {target: {value: 'draft-run'}});
  fireEvent.change(screen.getByLabelText('Seed'), {target: {value: 'draft-seed'}});
  fireEvent.click(screen.getByRole('button', {name: 'Create tournament'}));
  const login = await screen.findByRole('link', {name: 'Sign in'});
  expect(screen.getByText(/last operation will not be retried/)).toBeInTheDocument();
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  // Prevent jsdom navigation, while exercising the draft-save handler.
  login.addEventListener('click', event => event.preventDefault());
  fireEvent.click(login);
  expect(JSON.parse(sessionStorage.getItem('operator-draft')!)).toEqual({runId: 'draft-run', seed: 'draft-seed', mode: 'sample', concurrency: 2});
  view.unmount(); render(<App />);
  await screen.findByRole('button', {name: 'Create tournament'});
  expect(screen.getByLabelText('Run ID')).toHaveValue('draft-run');
  expect(screen.getByLabelText('Seed')).toHaveValue('draft-seed');
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

test('successful creation selects pending progress on a protected route', async () => {
  const run = {runId: 'accepted', seed: 'seed', concurrency: 2, mode: 'sample', phase: 'pending', archiveReady: false};
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/session')) return json(session);
    if (String(url).endsWith('/logs')) return json({logs: ''});
    if (String(url).endsWith('/runs') && init?.method !== 'POST') return json({runs: []});
    return json({run}, init?.method === 'POST' ? 202 : 200);
  });
  render(<App />); await screen.findByRole('button', {name: 'Create tournament'});
  fireEvent.change(screen.getByLabelText('Run ID'), {target: {value: 'accepted'}});
  fireEvent.change(screen.getByLabelText('Seed'), {target: {value: 'seed'}});
  fireEvent.click(screen.getByRole('button', {name: 'Create tournament'}));
  await screen.findByRole('heading', {name: 'accepted'});
  expect(screen.getByRole('status')).toHaveTextContent('Waiting to start');
  expect(window.location.pathname).toBe('/operate/runs/accepted');
});

test('API errors remain 401/403 even for plain ALB responses and requests carry explicit CSRF protection', async () => {
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', {status: 401}));
  await expect(controlRequest('runs', 'never-send-this', {method: 'POST', body: {}})).rejects.toMatchObject({status: 401});
  expect(request.mock.calls[0][1]).toMatchObject({credentials: 'same-origin', redirect: 'error', headers: {'x-control-csrf': '1'}});
  expect(request.mock.calls[0][1]!.headers).not.toHaveProperty('authorization');
  request.mockResolvedValue(new Response('', {status: 403}));
  await expect(controlRequest('session', '')).rejects.toMatchObject({status: 403});
});

test('public dashboard uses a browser link; return navigation is confined to operator pages', async () => {
  window.history.replaceState({}, '', '/');
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({runs: []}));
  render(<App />);
  expect(screen.getByRole('link', {name: 'Run a tournament'})).toHaveAttribute('href', '/operate');
  for (const path of ['//attacker.invalid', 'https://attacker.invalid', '/operate?next=//attacker', '/operate/%2f%2fhost', '/runs/secret', '/operate/runs/../']) expect(safeOperatorPath(path)).toBe('/operate');
  expect(safeOperatorPath('/operate/runs/sample-one')).toBe('/operate/runs/sample-one');
  await waitFor(() => expect(screen.getByText('No completed runs yet')).toBeInTheDocument());
});

test('managed logout calls the server to expire cookies and obtains the Cognito logout destination', async () => {
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({logoutUrl: 'https://pool.example/logout?client_id=client&logout_uri=https%3A%2F%2Flab.example%2F'}));
  expect(await managedLogout()).toContain('/logout?');
  expect(request).toHaveBeenCalledWith('/auth/logout', expect.objectContaining({method: 'POST', headers: {'x-control-csrf': '1', accept: 'application/json'}}));
  request.mockResolvedValue(json({logoutUrl: 'javascript:alert(1)'}));
  await expect(managedLogout()).rejects.toThrow('Invalid sign-out');
});
