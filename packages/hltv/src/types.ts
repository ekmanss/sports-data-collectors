/// <reference lib="esnext.disposable" />

export type HltvErrorCode =
  | 'INVALID_INPUT'
  | 'BROWSER_LAUNCH_FAILED'
  | 'NAVIGATION_FAILED'
  | 'TIMEOUT'
  | 'ACCESS_BLOCKED'
  | 'MATCH_NOT_FOUND'
  | 'INCOMPLETE_CAPTURE'
  | 'ABORTED'
  | 'CLIENT_CLOSED'
  | 'INTERNAL_ERROR';

export type HltvOperation =
  | 'client'
  | 'live-list'
  | 'match-detail'
  | 'completed-match-stats';

export type CaptureStage =
  | 'validating-input'
  | 'launching-browser'
  | 'queued'
  | 'throttling'
  | 'navigating'
  | 'validating-source'
  | 'extracting-page'
  | 'extracting-scorebot'
  | 'stabilizing'
  | 'building-output'
  | 'validating-output'
  | 'completed';

export interface HltvProgressEvent {
  operation: HltvOperation;
  stage: CaptureStage;
  attempt: number;
  message: string;
  timestamp: string;
}

export interface HltvProxyOptions {
  server: string;
  username?: string;
  password?: string;
}

export interface HltvClientOptions {
  headless?: boolean;
  proxy?: HltvProxyOptions;
  timezone?: string;
  maxConcurrency?: number;
  minRequestIntervalMs?: number;
  livePageRefreshIntervalMs?: number;
  matchSessionIdleTimeoutMs?: number;
  maxMatchSessions?: number;
}

export interface HltvRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: HltvProgressEvent) => void;
}

export type GetHltvMatchOptions = HltvClientOptions & HltvRequestOptions;
export type GetHltvLiveMatchesOptions = HltvClientOptions & HltvRequestOptions;
export type GetHltvCompletedMatchStatsOptions = HltvClientOptions & HltvRequestOptions;

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
  /** Canonical profile IDs retained for backwards-compatible consumers. */
  playerIds: number[];
  /**
   * Complete match roster. A stand-in can legitimately have no HLTV profile yet,
   * while its nickname and team membership are still explicit on the match page.
   */
  players?: Array<{ playerId: number | null; nickname: string }>;
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
  side: 'CT' | 'T' | null;
  players: ScoreboardPlayer[];
}

export interface CombinedScoreboard {
  fact: string | null;
  teams: ScoreboardTeam[];
}

export interface GameLogPlayer {
  playerId: number | null;
  nickname?: string;
  teamId: number | null;
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
  winnerTeamId: number | null;
  teamScore: Array<{ teamId: number; score: number }> | null;
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

export interface MatchStatMetrics {
  kills: number | null;
  deaths: number | null;
  adr: number | null;
  kastRate: number | null;
}

export interface MatchStatPlayer {
  playerId: number | null;
  nickname: string;
  traditional: MatchStatMetrics;
  ecoAdjusted: MatchStatMetrics;
  roundSwingRate: number | null;
  rating: number | null;
}

export interface MatchStatTeam {
  teamId: number | null;
  name: string;
  players: MatchStatPlayer[];
}

export interface MatchStatView {
  mapStatsId: number | null;
  map: string | null;
  side: 'both' | 'ct' | 't';
  teams: MatchStatTeam[];
}

export interface MatchStats {
  views: MatchStatView[];
}

export interface HltvCompletedMatchStats {
  schemaVersion: '1.0.0';
  capturedAt: string;
  sport: 'cs2';
  source: { provider: 'hltv'; url: string };
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
  maps: Array<{
    name: string;
    score: ScoreEntry[];
    halves: Array<{ team1: number; team2: number }>;
  }>;
  availability: 'available' | 'not-published';
  matchStats: MatchStats;
}

export interface CompletedMatchStatsDiagnostics {
  schemaVersion: '1.0.0';
  operation: 'completed-match-stats';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  collector: CollectorVersions;
  input: { id: number; slug: string; url: string };
  attempts: Array<{
    attempt: number;
    startedAt: string;
    completedAt: string;
    httpStatus: number | null;
    error?: { code: string; message: string };
  }>;
  capture: {
    httpStatus: number | null;
    navigationSeconds: number;
    totalSeconds: number;
    timings: MatchCaptureTimings;
  };
  warnings: DiagnosticWarning[];
}

export interface GetHltvCompletedMatchStatsResult {
  data: HltvCompletedMatchStats;
  diagnostics: CompletedMatchStatsDiagnostics;
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
  schemaVersion: '3.2.0';
  capturedAt: string;
  sport: 'cs2';
  source: { provider: 'hltv'; url: string };
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
  matchStats: MatchStats;
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
  schemaVersion: '3.0.0';
  operation: 'match-detail';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  collector: CollectorVersions;
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

export interface CollectorVersions {
  packageVersion: string;
  cloakbrowserVersion: string;
  playwrightVersion: string;
}

export interface HltvLiveTeam {
  id: number | null;
  name: string;
  logoUrl: string | null;
  score: {
    currentMap: number | null;
    mapsWon: number | null;
  };
}

export interface HltvLiveMatch {
  id: number;
  url: string;
  status: 'live';
  bestOf: number | null;
  region: string | null;
  isLan: boolean | null;
  event: {
    id: number | null;
    name: string | null;
    type: string | null;
    logoUrl: string | null;
  };
  teams: [HltvLiveTeam, HltvLiveTeam];
}

export interface HltvLiveMatchesData {
  schemaVersion: '1.0.0';
  capturedAt: string;
  sport: 'cs2';
  source: { provider: 'hltv'; url: 'https://www.hltv.org/matches' };
  matches: HltvLiveMatch[];
}

export interface HltvLiveWarning {
  code: string;
  matchId?: number;
  field?: string;
  reason: string;
}

export interface HltvLiveMatchesDiagnostics {
  schemaVersion: '1.0.0';
  operation: 'live-list';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  collector: CollectorVersions;
  attempts: Array<{
    attempt: number;
    startedAt: string;
    completedAt: string;
    httpStatus: number | null;
    error?: { code: HltvErrorCode; message: string };
  }>;
  summary: {
    cardsSeen: number;
    matchesReturned: number;
    cardsSkipped: number;
    duplicatesMerged: number;
  };
  capture?: {
    session: {
      reused: boolean;
      navigated: boolean;
      ageMs: number;
    };
  };
  warnings: HltvLiveWarning[];
}

export interface GetHltvLiveMatchesResult {
  data: HltvLiveMatchesData;
  diagnostics: HltvLiveMatchesDiagnostics;
}

export interface HltvClient extends AsyncDisposable {
  getLiveMatches(options?: HltvRequestOptions): Promise<GetHltvLiveMatchesResult>;
  getMatch(matchUrl: string, options?: HltvRequestOptions): Promise<GetHltvMatchResult>;
  getCompletedMatchStats(
    matchUrl: string,
    options?: HltvRequestOptions,
  ): Promise<GetHltvCompletedMatchStatsResult>;
  close(): Promise<void>;
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
  teams: Array<{
    team: string;
    side?: 'CT' | 'T' | null;
    players: Array<{ player: string; cells: RawCell[] }>;
  }>;
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

export interface RawMatchStatPlayer {
  id: number | null;
  nickname: string;
  fullName?: string | null;
  country?: string | null;
  profileUrl?: string | null;
  kills: string;
  deaths: string;
  ecoAdjustedKills: string;
  ecoAdjustedDeaths: string;
  roundSwing: string;
  adr: string;
  ecoAdjustedAdr: string;
  kast: string;
  ecoAdjustedKast: string;
  rating: string;
}

export interface RawMatchStatTeam {
  id: number | null;
  name: string;
  players: RawMatchStatPlayer[];
}

export interface RawMatchStatView {
  mapStatsId: number | null;
  map: string | null;
  side: 'both' | 'ct' | 't';
  teams: RawMatchStatTeam[];
}

export interface RawMatchStats {
  views: RawMatchStatView[];
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
  matchStats?: RawMatchStats | null;
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
  gameLog: {
    scrollHeight: number;
    chronological: RawLogEvent[];
    excludedNoiseEvents: number;
    positionsVisited?: number;
  };
  note: string | null;
}

export interface MatchCaptureTimings {
  metadataMs: number;
  newPageMs: number;
  navigationMs: number;
  pageReadyMs: number;
  scorebotReloadMs: number;
  scorebotReadyMs: number;
  snapshotPageMs: number;
  scoreboardsMs: number;
  gameLogMs: number;
  pageCloseMs: number;
}

export interface CaptureAttempt {
  initialPage: RawExtractedPage;
  snapshot: RawSnapshot;
  collector: CollectorVersions;
  httpStatus: number | null;
  navigationSeconds: number;
  totalSeconds: number;
  timings?: MatchCaptureTimings;
  attempt: number;
  startedAt: string;
  completedAt: string;
  session?: {
    reused: boolean;
    snapshotCacheHit: boolean;
    ageMs: number;
  };
}

export interface RawLiveTeam {
  id: number | null;
  name: string;
  logoUrl: string | null;
  currentMap: number | null;
  mapsWon: number | null;
}

export interface RawLiveCard {
  id: number | null;
  url: string | null;
  bestOf: number | null;
  region: string | null;
  isLan: boolean | null;
  event: {
    id: number | null;
    name: string | null;
    type: string | null;
    logoUrl: string | null;
  };
  teams: RawLiveTeam[];
}

export interface RawLivePage {
  title: string;
  url: string;
  recognized: boolean;
  challenge: boolean;
  cardsSeen: number;
  cards: RawLiveCard[];
}
