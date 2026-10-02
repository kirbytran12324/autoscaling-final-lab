import type {Match, Outcome} from './types';

export function formatOutcome(outcome: Outcome, winnerSpecies?: string | null) {
  return {
    result: outcome,
    winner: outcome === 'tie' ? 'Draw' : (winnerSpecies || 'Not reported'),
    evidence: outcome === 'tie' ? 'tie / Draw' : `win / ${winnerSpecies || 'Not reported'}`,
  };
}

export function matchOutcome(match: Pick<Match, 'outcome' | 'winnerSpecies'>) {
  return formatOutcome(match.outcome, match.winnerSpecies);
}

export function formatNumber(value: number) {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : 'Unavailable';
}
