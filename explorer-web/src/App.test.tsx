import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, describe, expect, test, vi} from 'vitest';
import App from './App';
import type {Match, ReportFacts} from './types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('completed-runs dashboard states', () => {
  test('shows a loading state while runs are requested', () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}));
    render(<App />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading completed runs');
  });

  test('shows the empty state when no completed run is discoverable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({runs: []}));
    render(<App />);
    expect(await screen.findByText('No completed runs yet')).toBeInTheDocument();
    expect(screen.getByText(/every canonical artifact passes strict completion validation/i)).toBeInTheDocument();
  });

  test('shows the API error state with a retry action', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({error: {code: 'ARTIFACT_STORE_UNAVAILABLE', message: 'Tournament artifacts are temporarily unavailable.'}}),
      {status: 500, headers: {'content-type': 'application/json'}}
    ));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Tournament artifacts are temporarily unavailable');
    expect(screen.getByRole('button', {name: 'Try again'})).toBeEnabled();
  });
});

const win: Match = {
  matchId: 'group-B-000006', pokemon1: 'Kyogre', pokemon2: 'Espeon', outcome: 'win',
  winnerSide: 'p1', winnerSpecies: 'Kyogre', turns: 5, termination: 'natural',
  seed: [9933, 16872, 34519, 33724], simulatorVersion: 'pokemon-showdown@0.11.11',
  protocolHash: 'd50b132fb608cf2a472b64fdf0a681f0610e1f3bce58066942fbb7bdc4b62dae',
  servedBy: 'simulator-pod-a', durationMs: 586.351, stage: 'Group stage', group: 'B',
};

const tie: Match = {
  ...win, matchId: 'group-B-000007', pokemon1: 'Mew', pokemon2: 'Ditto', outcome: 'tie',
  winnerSide: null, winnerSpecies: null, turns: 100, termination: 'turn-cap',
  protocolHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

const champion = {
  finalSeriesId: 'r2-series-01', winnerSlot: 'entrant1',
  champion: {group: 'B', rank: 1, speciesId: 'kyogre', species: 'Kyogre', sourceSeriesId: 'r4-series-01'},
  resolution: 'two-wins', gamesPlayed: 3, entrant1Wins: 2, entrant2Wins: 1,
  draws: 0, lotteryHash: null,
};

const report: ReportFacts = {
  generatedAt: '2026-09-30T00:00:00.000Z',
  sourceFiles: ['run-metadata.json', 'roster.json', 'results.jsonl', 'checkpoint.json', 'standings.json', 'bracket.json'],
  champion,
  integrity: {verified: true, expectedAcceptedResults: 146, acceptedResultRecords: 146, uniqueMatchIds: 146, duplicateMatchIds: 0, invalidJsonRecords: 0, terminalBattleFailures: 0, knockoutResultCount: 34, knockoutRoundCount: 4, standingsStatus: 'final', standingsAcceptedResultCount: 112, standingsExpectedResultCount: 112, bracketStatus: 'completed'},
  statistics: {wallClockMs: 8617, durations: {min: 100, mean: 500, median: 450, p95: 900, p99: 1000, max: 1100}, wins: 145, draws: 1, turnCaps: 1, terminalFailures: 0, slowest: [{...tie, formattedDuration: '1.10 s'}], formatted: {wallClock: '8.62 s', minimum: '100 ms', mean: '500 ms', median: '450 ms', p95: '900 ms', p99: '1 s', maximum: '1.10 s'}},
  podAttribution: {totalAcceptedCount: 146, attributedCount: 146, unattributedCount: 0, distinctHostnameCount: 1, stages: [{stage: 'Group stage', count: 112}, {stage: 'Knockout', count: 34}], rows: [{fullHostname: 'simulator-pod-a', sharedPrefix: '', distinguishingPart: 'simulator-pod-a', acceptedCount: 146, acceptedShare: 100, stageCounts: {'Group stage': 112, Knockout: 34}}]},
  matchFacets: {stages: ['Group stage', 'Knockout'], hostnames: ['simulator-pod-a']},
};

function jsonResponse(body: object) {
  return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
}

function installFixtureApi() {
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input); requests.push(url);
    if (url.includes('/standings?')) {
      const selectedGroup = new URL(url, 'http://local').searchParams.get('group') || 'A';
      return jsonResponse({standings: {advancingCount: 4, updatedAt: '2026-09-23T03:12:35.286Z', selectedGroup, total: 1, nextCursor: selectedGroup === 'A' ? 'next-standing' : null, groups: [{group: 'A', completedMatches: 28, expectedMatches: 28, entrantCount: 8}, {group: 'B', completedMatches: 28, expectedMatches: 28, entrantCount: 8}], items: [{group: selectedGroup, speciesId: selectedGroup === 'A' ? 'blastoise' : 'kyogre', species: selectedGroup === 'A' ? 'Blastoise' : 'Kyogre', played: 7, wins: 5, draws: 0, losses: 2, points: 15, miniTablePoints: 3, sonnebornBerger: 102, tieKey: 'tie-key', rank: 1}]}});
    }
    if (url.endsWith('/bracket')) return jsonResponse({bracket: {updatedAt: '2026-09-23T03:12:35.286Z', champion, rounds: [{round: 'r2', series: [{seriesId: 'r2-series-01', position: 1, entrant1: champion.champion, entrant2: {speciesId: 'garchomp', species: 'Garchomp'}, games: [{...win, stage: 'Knockout', round: 'r2', seriesId: 'r2-series-01', gameNumber: 1}], evaluation: {...champion, winner: champion.champion}}]}]}});
    if (url.includes('/matches?')) return jsonResponse({items: [win, tie], total: 2, nextCursor: url.includes('cursor=') ? null : 'next-match'});
    return jsonResponse({run: {runId: 'sample-32-002', mode: 'sample', status: 'completed', startedAt: '2026-09-23T03:12:26.669Z', completedAt: '2026-09-23T03:12:35.286Z', tournamentSeed: 'sample-32-seed-002', rulesVersion: 'metronome-singles-v1', simulatorVersion: 'pokemon-showdown@0.11.11', simulatorImage: 'metronome-simulator:phase10', runnerConcurrency: 6, entrantCount: 32, matchCount: 146, failureCount: 0, champion: champion.champion, hasReport: true, rosterHash: '3605d9172fe2e9082af58de7b98cd7796e5ed908bcdaab2ca8c3b448d3a1e27b', rosterHashVerified: true, duplicateMatchIdCount: 0, checkpoint: {stage: 'complete', round: 'r2', acceptedResultCount: 146, updatedAt: '2026-09-23T03:12:35.286Z'}, report}});
  });
  return requests;
}

test('restores the complete offline report section structure and evidence', async () => {
  window.history.replaceState({}, '', '/runs/sample-32-002');
  installFixtureApi();
  render(<App />);
  expect(await screen.findByRole('heading', {name: 'sample-32-002'})).toBeInTheDocument();
  for (const heading of ['Tournament outcome', 'Verification', 'Group standings', 'Knockout rounds', 'Battle explorer', 'Accepted battles by reported simulator Pod', 'Run details']) {
    expect(screen.getByRole('heading', {name: heading})).toBeInTheDocument();
  }
  expect(await screen.findByRole('tab', {name: 'Group A'})).toHaveAttribute('aria-selected', 'true');
  for (const column of ['Rank', 'Species', 'Mini pts', 'SB', 'Tie key']) expect(screen.getByRole('columnheader', {name: column})).toBeInTheDocument();
  expect(screen.getByText('Garchomp')).toBeInTheDocument();
  expect(screen.getByText('Configuration and timing')).toBeInTheDocument();
  expect(screen.getByText('Methodology, sources, and limitations')).toBeInTheDocument();
  expect(screen.getByRole('link', {name: 'Download offline report'})).toHaveAttribute('href', '/api/runs/sample-32-002/report');
  expect(screen.queryByRole('button', {name: 'Watch replay'})).not.toBeInTheDocument();
});

test('uses API-backed filters, sorting and cursor pagination', async () => {
  window.history.replaceState({}, '', '/runs/sample-32-002');
  const requests = installFixtureApi();
  render(<App />);
  const disclosure = await screen.findByText(/Search and browse 146 accepted simulations/);
  fireEvent.click(disclosure);
  fireEvent.change(screen.getByLabelText('Stage'), {target: {value: 'Knockout'}});
  fireEvent.change(screen.getByLabelText('Result'), {target: {value: 'tie'}});
  fireEvent.change(screen.getByLabelText('Reported hostname'), {target: {value: 'simulator-pod-a'}});
  fireEvent.click(screen.getByRole('button', {name: 'Turns'}));
  await waitFor(() => expect(requests.some(url => url.includes('stage=Knockout') && url.includes('result=tie') && url.includes('hostname=simulator-pod-a') && url.includes('sort=turns'))).toBe(true));
  const battleToolbar = screen.getByLabelText('Battle explorer controls');
  await waitFor(() => expect(within(battleToolbar).getByRole('button', {name: 'Next'})).toBeEnabled());
  fireEvent.click(within(battleToolbar).getByRole('button', {name: 'Next'}));
  await waitFor(() => expect(requests.some(url => url.includes('cursor=next-match'))).toBe(true));
  fireEvent.click(within(battleToolbar).getByRole('button', {name: 'Reset filters'}));
  expect(screen.getByLabelText('Stage')).toHaveValue('');
});

test('supports keyboard tabs and keyboard row selection, including canonical tie results', async () => {
  window.history.replaceState({}, '', '/runs/sample-32-002');
  const requests = installFixtureApi();
  render(<App />);
  const firstTab = await screen.findByRole('tab', {name: 'Group A'});
  firstTab.focus(); fireEvent.keyDown(firstTab, {key: 'ArrowRight'});
  await waitFor(() => expect(requests.some(url => url.includes('group=B'))).toBe(true));
  const disclosure = screen.getByText(/Search and browse 146 accepted simulations/);
  fireEvent.click(disclosure);
  const tieRow = await screen.findByRole('row', {name: 'Open details for group-B-000007'});
  tieRow.focus(); fireEvent.keyDown(tieRow, {key: 'Enter'});
  const detail = screen.getByRole('complementary');
  expect(within(detail).getByText('tie')).toBeInTheDocument();
  expect(within(detail).getByText('Draw')).toBeInTheDocument();
  expect(within(detail).getByText('Duration (ms)')).toBeInTheDocument();
  expect(within(detail).getByText('586.351')).toBeInTheDocument();
  expect(within(detail).getByRole('button', {name: 'Watch replay'})).toBeDisabled();
  expect(within(detail).getByRole('button', {name: 'Copy Reported hostname'})).toBeEnabled();
  expect(tieRow).toHaveAttribute('aria-selected', 'true');
});


test('filter changes disable obsolete cursors and ignore aborted responses', async () => {
  window.history.replaceState({}, '', '/runs/sample-32-002');
  const requests = installFixtureApi();
  render(<App />);
  fireEvent.click(await screen.findByText(/Search and browse 146 accepted simulations/));
  const toolbar = screen.getByLabelText('Battle explorer controls');
  const next = within(toolbar).getByRole('button', {name: 'Next'});
  await waitFor(() => expect(next).toBeEnabled());
  const original = vi.mocked(fetch).getMockImplementation()!;
  const pending: ((response: Response) => void)[] = [];
  vi.mocked(fetch).mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/matches?') && url.includes('q=')) {
      requests.push(url);
      return new Promise<Response>(resolve => pending.push(resolve));
    }
    return original(input, init);
  });
  fireEvent.change(within(toolbar).getByPlaceholderText('Match ID or species'), {target: {value: 'first'}});
  expect(next).toBeDisabled();
  fireEvent.click(next); fireEvent.click(next);
  expect(requests.at(-1)).not.toContain('cursor=');
  fireEvent.change(within(toolbar).getByPlaceholderText('Match ID or species'), {target: {value: 'second'}});
  await waitFor(() => expect(pending.length).toBe(2));
  await act(async () => {pending[1](jsonResponse({items: [tie], total: 1, nextCursor: null}));});
  await act(async () => {pending[0](jsonResponse({items: [win], total: 999, nextCursor: 'obsolete'}));});
  expect(next).toBeDisabled();
  expect(within(toolbar).getByText('1 matching battles')).toBeInTheDocument();
  expect(screen.queryByRole('row', {name: `Open details for ${win.matchId}`})).not.toBeInTheDocument();
});

test('standings pagination stays disabled while a new search is pending', async () => {
  window.history.replaceState({}, '', '/runs/sample-32-002');
  installFixtureApi(); render(<App />);
  const toolbar = await screen.findByLabelText('Standings controls');
  const next = within(toolbar).getByRole('button', {name: 'Next'});
  await waitFor(() => expect(next).toBeEnabled());
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => String(input).includes('q=waiting')
    ? new Promise(() => {}) : original(input, init));
  fireEvent.change(within(toolbar).getByPlaceholderText('Pokémon name'), {target: {value: 'waiting'}});
  expect(next).toBeDisabled();
  fireEvent.click(next);
  expect(String(vi.mocked(fetch).mock.calls.at(-1)?.[0])).not.toContain('cursor=');
});


test('failed filter updates clear obsolete pagination in both views', async () => {
  window.history.replaceState({}, '', '/runs/sample-32-002');
  installFixtureApi(); render(<App />);
  fireEvent.click(await screen.findByText(/Search and browse 146 accepted simulations/));
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => String(input).includes('q=failed')
    ? Promise.resolve(new Response(JSON.stringify({error: {code: 'INTERNAL_ERROR', message: 'Filtering unavailable.'}}), {status: 500}))
    : original(input, init));
  for (const [label, placeholder] of [['Standings controls', 'Pokémon name'], ['Battle explorer controls', 'Match ID or species']]) {
    const toolbar = screen.getByLabelText(label);
    const next = within(toolbar).getByRole('button', {name: 'Next'});
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.change(within(toolbar).getByPlaceholderText(placeholder), {target: {value: 'failed'}});
    await waitFor(() => expect(screen.queryAllByText('Filtering unavailable.').length).toBeGreaterThan(0));
    expect(next).toBeDisabled();
  }
  await waitFor(() => expect(screen.getAllByText('Filtering unavailable.')).toHaveLength(2));
});
