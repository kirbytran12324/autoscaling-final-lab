export type Outcome = 'win' | 'tie';
export type MatchStage = 'Group stage' | 'Knockout' | 'Unknown';
export type MatchSort = 'matchId' | 'stage' | 'matchup' | 'result' | 'winner' | 'turns';
export type SortDirection = 'asc' | 'desc';

export interface Entrant {
  group?: string;
  rank?: number;
  speciesId: string;
  species: string;
  sourceSeriesId?: string;
}

export interface RunSummary {
  runId: string;
  mode: 'sample' | 'full';
  status: 'completed';
  startedAt: string;
  completedAt: string;
  tournamentSeed: string;
  rulesVersion: string;
  simulatorVersion: string;
  simulatorImage: string;
  runnerConcurrency: number;
  entrantCount: number;
  matchCount: number;
  failureCount: number;
  champion: Entrant;
  hasReport: boolean;
}

export interface Match {
  matchId: string;
  pokemon1: string;
  pokemon2: string;
  outcome: Outcome;
  winnerSide: 'p1' | 'p2' | null;
  winnerSpecies: string | null;
  turns: number;
  termination: string;
  seed: number[];
  simulatorVersion: string;
  protocolHash: string;
  servedBy?: string;
  durationMs?: number;
  stage: MatchStage;
  group?: string;
  round?: string;
  seriesId?: string;
  gameNumber?: number;
}

export interface PodRow {
  fullHostname: string;
  sharedPrefix: string;
  distinguishingPart: string;
  acceptedCount: number;
  acceptedShare: number;
  stageCounts: Record<string, number>;
}

export interface ChampionResult {
  finalSeriesId: string;
  winnerSlot: string;
  champion: Entrant;
  resolution: string;
  gamesPlayed: number;
  entrant1Wins: number;
  entrant2Wins: number;
  draws: number;
  lotteryHash: string | null;
}

export interface ReportFacts {
  generatedAt: string;
  sourceFiles: string[];
  champion: ChampionResult;
  integrity: {
    verified: boolean;
    expectedAcceptedResults: number;
    acceptedResultRecords: number;
    uniqueMatchIds: number;
    duplicateMatchIds: number;
    invalidJsonRecords: number;
    terminalBattleFailures: number;
    knockoutResultCount: number;
    knockoutRoundCount: number;
    standingsStatus: string;
    standingsAcceptedResultCount: number;
    standingsExpectedResultCount: number;
    bracketStatus: string;
  };
  statistics: {
    wallClockMs: number;
    durations: {min: number; mean: number; median: number; p95: number; p99: number; max: number};
    wins: number;
    draws: number;
    turnCaps: number;
    terminalFailures: number;
    slowest: (Match & {formattedDuration: string})[];
    formatted: {wallClock: string; minimum: string; mean: string; median: string; p95: string; p99: string; maximum: string};
  };
  podAttribution: {
    totalAcceptedCount: number;
    attributedCount: number;
    unattributedCount: number;
    distinctHostnameCount: number;
    stages: {stage: string; count: number}[];
    rows: PodRow[];
  };
  matchFacets: {stages: MatchStage[]; hostnames: string[]};
}

export interface RunDetail extends RunSummary {
  rosterHash: string;
  rosterHashVerified: boolean;
  duplicateMatchIdCount: number;
  checkpoint: {stage: string; round: string; acceptedResultCount: number; updatedAt: string};
  report: ReportFacts;
}

export interface Standing {
  group: string;
  speciesId: string;
  species: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  miniTablePoints: number;
  sonnebornBerger: number;
  tieKey: string;
  rank: number;
}

export interface StandingGroupSummary {
  group: string;
  completedMatches: number;
  expectedMatches: number;
  entrantCount: number;
}

export interface StandingsPage {
  advancingCount: number;
  updatedAt: string;
  groups: StandingGroupSummary[];
  selectedGroup: string;
  items: Standing[];
  total: number;
  nextCursor: string | null;
}

export interface SeriesEvaluation {
  gamesPlayed: number;
  entrant1Wins: number;
  entrant2Wins: number;
  draws: number;
  winner: Entrant;
  resolution: string;
  lotteryHash: string | null;
}

export interface Series {
  seriesId: string;
  position: number;
  entrant1: Entrant;
  entrant2: Entrant;
  games: Match[];
  evaluation: SeriesEvaluation;
}

export interface BracketRound {round: string; series: Series[]}
export interface Bracket {
  rounds: BracketRound[];
  champion: ChampionResult;
  updatedAt: string;
}

export interface MatchPage {items: Match[]; total: number; nextCursor: string | null}
