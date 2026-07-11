export type HltvMatchErrorCode =
  | 'INVALID_INPUT'
  | 'BROWSER_NOT_INSTALLED'
  | 'NAVIGATION_FAILED'
  | 'ACCESS_BLOCKED'
  | 'MATCH_NOT_FOUND'
  | 'INCOMPLETE_CAPTURE'
  | 'ABORTED'
  | 'INTERNAL_ERROR';

export type CaptureStage =
  | 'validating-input'
  | 'launching-browser'
  | 'navigating'
  | 'validating-source'
  | 'extracting-page'
  | 'extracting-scorebot'
  | 'building-output'
  | 'validating-output'
  | 'completed';

export interface HltvMatchProgressEvent {
  stage: CaptureStage;
  attempt: number;
  message: string;
  timestamp: string;
}

export interface GetHltvMatchOptions {
  headless?: boolean;
  pageWaitMs?: number;
  scorebotWaitMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: HltvMatchProgressEvent) => void;
}

export interface NormalizedGetHltvMatchOptions {
  id: number;
  slug: string;
  url: string;
  headless: boolean;
  pageWaitMs: number;
  scorebotWaitMs: number;
  signal?: AbortSignal;
  onProgress?: (event: HltvMatchProgressEvent) => void;
}

export interface HltvEvent {
  id: number | null;
  name: string;
  url: string | null;
}

export interface HltvTeam {
  id: number;
  name: string;
  country: string | null;
  url: string | null;
  logo: string | null;
}

export interface PlayerMetrics {
  rating: number | null;
  killsPerRound: number | null;
  deathsPerRound: number | null;
  kastRate: number | null;
  adr: number | null;
  multiKillRating: number | null;
  roundSwingRate: number | null;
}

export interface HltvPlayer {
  id: number;
  nickname: string;
  fullName: string | null;
  country: string | null;
  image: string | null;
  bodyshotUrl: string | null;
  profileUrl: string | null;
  statsUrl: string | null;
  metrics: PlayerMetrics;
}

export interface MatchLineup {
  teamId: number;
  worldRank: number | null;
  playerIds: number[];
}

export interface VetoEntry {
  order: number;
  teamId: number | null;
  action: 'remove' | 'pick' | 'left_over';
  map: string;
}

export interface MatchStream {
  name: string;
  viewers: number | null;
  url: string | null;
  embedUrl: string | null;
}

export interface ScoreEntry {
  teamId: number | null;
  score: number;
}

export interface ScoreboardPlayer {
  playerId: number | null;
  nickname?: string;
  state: Record<string, string | number | boolean | string[] | null>;
  normal: Record<string, string | number | boolean | string[] | null>;
  advanced: Record<string, string | number | boolean | string[] | null>;
}

export interface ScoreboardTeam {
  teamId: number | null;
  name?: string;
  players: ScoreboardPlayer[];
}

export interface CombinedScoreboard {
  fact: string | null;
  teams: ScoreboardTeam[];
}

export interface GameLogPlayer {
  playerId: number | null;
  nickname?: string;
  side: 'CT' | 'T';
}

export interface GameLogEvent {
  kind: string;
  text: string;
  players?: GameLogPlayer[];
  weapon?: string;
  headshot?: true;
}

export interface RoundResult {
  winnerSide: 'CT' | 'T' | null;
  sideScore: { ct: number; t: number | null } | null;
  reason: string | null;
}

export interface GameRound {
  number: number;
  events: GameLogEvent[];
  result: RoundResult | null;
}

export interface MatchMap {
  name: string;
  status: 'completed' | 'current' | 'upcoming';
  optional: boolean;
  pickedByTeamId: number | null;
  score: ScoreEntry[];
  halves: Array<{ team1: number; team2: number }>;
  scoreboard: ({ capturedAt: string } & CombinedScoreboard) | null;
  gameLog: { rounds: GameRound[] };
}

export interface MapStatTeam {
  teamId: number | null;
  action: string | null;
  percentage: number | null;
  sample: { count: number; unit: string } | null;
  statsUrl: string | null;
}

export interface MapStatRow {
  map: string;
  mapCode: string | null;
  excludedFromSeries: boolean;
  teams: MapStatTeam[];
}

export interface MapStats {
  teamIds: Array<number | null>;
  metrics: Record<string, MapStatRow[]>;
}

export interface RecentMatch {
  opponent: { id: number | null; name: string; country: string | null; url: string | null };
  timeAgo: string | null;
  format: string;
  score: { team: number; opponent: number } | null;
  result: 'won' | 'lost' | null;
  match: { id: number | null; url: string | null };
}

export interface RecentMatches {
  period: string;
  views: Array<{
    modes: string[];
    teams: Array<{ teamId: number | null; matches: RecentMatch[] }>;
  }>;
}

export interface HeadToHead {
  summary: {
    teams: Array<{ teamId: number | null; wins: number }>;
    overtimes: number;
  };
  matches: Array<{
    id: number | null;
    url: string | null;
    date: string;
    unixMs: number | null;
    event: HltvEvent;
    lineups: Array<{ teamId: number | null; players: string[]; winner: boolean }>;
    maps: Array<{
      name: string;
      code: string;
      picked: boolean;
      scores: ScoreEntry[];
    }>;
  }>;
}

export interface HltvMatch {
  schemaVersion: '2.1.0';
  generatedAt: string;
  source: string;
  collector: { language: 'TypeScript'; cloakbrowser: string; playwright: string };
  match: {
    id: number;
    slug: string;
    status: string;
    scheduledUnixMs: number | null;
    event: HltvEvent;
    format: string;
    stage: string;
  };
  teams: HltvTeam[];
  players: HltvPlayer[];
  lineups: MatchLineup[];
  veto: VetoEntry[];
  streams: MatchStream[];
  maps: MatchMap[];
  current: {
    capturedAt: string;
    map: string;
    round: number | null;
    score: ScoreEntry[];
    scoreboard: CombinedScoreboard | null;
  } | null;
  mapStats: MapStats;
  recentMatches: RecentMatches;
  headToHead: HeadToHead;
}

export interface DiagnosticWarning {
  code: string;
  reason?: string;
  section?: string;
  map?: string;
  [key: string]: unknown;
}

export interface MapCheck {
  status: MatchMap['status'];
  scoreSum: number;
  completedRounds: number;
  consistent: boolean;
  scoreboardIncluded: boolean;
}

export interface MatchDiagnostics {
  schemaVersion: '2.0.0';
  generatedAt: string;
  input: { id: number; slug: string; url: string };
  attempts: Array<{
    attempt: number;
    startedAt: string;
    completedAt: string;
    httpStatus: number | null;
    error?: { code: string; message: string };
  }>;
  capture: Record<string, unknown>;
  reconciliation: Record<string, unknown>;
  mapChecks: Record<string, MapCheck>;
  mergedRecentModes: string[][];
  warnings: DiagnosticWarning[];
}

export interface GetHltvMatchResult {
  data: HltvMatch;
  diagnostics: MatchDiagnostics;
}

export interface RawImageInfo {
  src: string | null;
  alt: string | null;
  title: string | null;
}

export interface RawCell {
  className: string;
  text: string;
  images: RawImageInfo[];
}

export interface RawScoreboard {
  mode: string;
  round: string;
  fact: string;
  score: string;
  teams: Array<{ team: string; players: Array<{ player: string; cells: RawCell[] }> }>;
}

export interface RawLogEvent {
  top: number;
  type: string[];
  text: string;
  players: Array<{ name: string; side: 'CT' | 'T' }>;
  weapon: string | null;
  headshot: boolean;
}

export interface RawTeam {
  id: number | null;
  name: string;
  url: string | null;
  country: string | null;
  logo: string | null;
}

export interface RawPlayer {
  id: number | null;
  nickname: string;
  fullName: string | null;
  country: string | null;
  image: string | null;
  profileUrl: string | null;
  statsUrl: string | null;
  rating: unknown;
  kpr: unknown;
  dpr: unknown;
  kast: unknown;
  adr: unknown;
  stats: Record<string, unknown>;
}

export interface RawLineup {
  id: number | null;
  name: string;
  worldRank: number | null;
  players: RawPlayer[];
}

export interface RawMapCard {
  name: string;
  optional: boolean;
  teams: Array<{ name: string; score: string; picked: boolean }>;
  halfScores: string;
}

export interface RawExtractedPage {
  title: string;
  url: string;
  match: { id: number | null; status: string; scheduledUnixMs: number | null; event: HltvEvent };
  teams: RawTeam[];
  maps: { format: string; stage: string; veto: string[]; maps: RawMapCard[] };
  streams: Array<{ name: string; viewers: string; url: string | null; embedUrl: string | null }>;
  lineups: RawLineup[];
  mapStats: unknown;
  recentMatches: unknown[];
  headToHead: unknown;
  sections: Record<string, boolean>;
  [key: string]: unknown;
}

export interface RawSnapshot {
  capturedAt: string;
  httpStatus: number | null;
  page: RawExtractedPage;
  scoreboardNormal: RawScoreboard | null;
  scoreboardAdvanced: RawScoreboard | null;
  gameLog: { scrollHeight: number; chronological: RawLogEvent[]; excludedNoiseEvents: number };
  note: string | null;
}

export interface CaptureAttempt {
  initialPage: RawExtractedPage;
  snapshot: RawSnapshot;
  collector: { cloakbrowser: string; playwright: string };
  httpStatus: number | null;
  navigationSeconds: number;
  totalSeconds: number;
  attempt: number;
  startedAt: string;
  completedAt: string;
}
