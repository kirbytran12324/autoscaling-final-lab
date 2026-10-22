import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {MatchDetail} from './report/battles';
import * as api from './api';
import type {Match, VerifiedReplay} from './types';

const match: Match = {matchId: 'group-A-000001', pokemon1: 'Snorlax', pokemon2: 'Blastoise',
  outcome: 'win', winnerSide: 'p2', winnerSpecies: 'Blastoise', turns: 4, termination: 'natural',
  seed: [48906, 52980, 4687, 23748], simulatorVersion: 'pokemon-showdown@0.11.11',
  protocolHash: 'a'.repeat(64), stage: 'Group stage'};
const replay: VerifiedReplay = {runId: 'sample', matchId: match.matchId,
  rulesVersion: 'metronome-singles-v1', simulatorVersion: match.simulatorVersion,
  protocolHash: match.protocolHash, verified: true, log: '|turn|4\n|win|p2\n'};

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {configurable: true,
    value: function (this: HTMLDialogElement) {this.open = true;}});
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {configurable: true,
    value: function (this: HTMLDialogElement) {this.open = false;}});
});
afterEach(() => {cleanup(); vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');});

function open() {
  render(<MatchDetail runId="sample" match={match} />);
  const button = screen.getByRole('button', {name: 'Watch replay'});
  button.focus(); fireEvent.click(button);
  return button;
}

test('opens paused-player dialog only after verification and restores focus on closing', async () => {
  vi.spyOn(api, 'loadReplay').mockResolvedValue(replay);
  const opener = open();
  expect(screen.getByRole('status')).toHaveTextContent('Recreating and verifying');
  expect(screen.queryByTitle(/Battle replay:/)).not.toBeInTheDocument();
  const frame = await screen.findByTitle(/Battle replay:/);
  expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  expect(new URL((frame as HTMLIFrameElement).src).searchParams.get('assetBaseUrl'))
    .toBe('http://127.0.0.1:4174/c0f6bfc-2026-10-05/');
  expect(screen.getByText('Verified against the saved result')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name: 'Close replay'}));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});

test('closing during generation aborts the request and ignores late results', async () => {
  let signal: AbortSignal | undefined;
  let complete!: (value: VerifiedReplay) => void;
  vi.spyOn(api, 'loadReplay').mockImplementation((run, id, abort) => {
    signal = abort; return new Promise(resolve => {complete = resolve;});
  });
  open(); fireEvent.click(screen.getByRole('button', {name: 'Close replay'}));
  expect(signal?.aborted).toBe(true);
  await act(async () => complete(replay));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('mismatch blocks the player while temporary errors can be retried', async () => {
  const load = vi.spyOn(api, 'loadReplay').mockRejectedValue(new api.ApiRequestError('Battle does not match.', 'REPLAY_MISMATCH', 409));
  open(); expect(await screen.findByRole('alert')).toHaveTextContent('Battle does not match');
  expect(screen.queryByTitle(/Battle replay:/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', {name: 'Try again'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name: 'Close replay'}));
  load.mockRejectedValueOnce(new api.ApiRequestError('Temporarily unavailable.', 'REPLAY_UNAVAILABLE', 503)).mockResolvedValue(replay);
  fireEvent.click(screen.getByRole('button', {name: 'Watch replay'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Temporarily unavailable');
  fireEvent.click(screen.getByRole('button', {name: 'Try again'}));
  expect(await screen.findByTitle(/Battle replay:/)).toBeInTheDocument();
});

test('message bridge checks origin, sender and replay identity, and supports frame Escape', async () => {
  vi.spyOn(api, 'loadReplay').mockResolvedValue(replay); open();
  const frame = await screen.findByTitle(/Battle replay:/) as HTMLIFrameElement;
  const replayId = new URL(frame.src).searchParams.get('replayId');
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  const message = (origin: string, source: Window, id = replayId, type = 'metronome-replay:ready') => {
    act(() => window.dispatchEvent(new MessageEvent('message', {origin, source, data: {type, replayId: id}})));
  };
  message('https://untrusted.invalid', frame.contentWindow!);
  message(window.location.origin, frame.contentWindow!);
  message('null', window);
  message('null', frame.contentWindow!, 'wrong-id');
  expect(post).not.toHaveBeenCalled();
  message('null', frame.contentWindow!);
  expect(post).toHaveBeenCalledWith(expect.objectContaining({type: 'metronome-replay:init', replayId, replay,
    assetBaseUrl: 'http://127.0.0.1:4174/c0f6bfc-2026-10-05/'}), '*');
  message('null', frame.contentWindow!, replayId, 'metronome-replay:escape');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test.each([undefined, 'https://assets.example/snapshot/?redirect=bad'])('graphics configuration %s keeps the player closed and the verified log available', async value => {
  const config = window.METRONOME_CONFIG;
  window.METRONOME_CONFIG = {...config, showdownAssetBaseUrl: value};
  vi.spyOn(api, 'loadReplay').mockResolvedValue(replay);
  try {
    const opener = open();
    expect(await screen.findByText('Verified against the saved result')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByTitle(/Battle replay:/)).not.toBeInTheDocument();
    expect(screen.getByText(/Configure/)).toHaveTextContent('showdownAssetBaseUrl');
    expect(screen.getByRole('dialog').querySelector('.replay-log-fallback .mono')).toHaveTextContent(replay.protocolHash);
    expect(document.querySelector('pre')).toHaveTextContent('|turn|4');
    fireEvent.click(screen.getByRole('button', {name: 'Close replay'}));
    expect(opener).toHaveFocus();
  } finally {window.METRONOME_CONFIG = config;}
});
