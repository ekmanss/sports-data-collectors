/// <reference lib="esnext.disposable" />

export type FiveEPlayJson =
  | null
  | boolean
  | number
  | string
  | FiveEPlayJson[]
  | { [key: string]: FiveEPlayJson };

export type FiveEPlayJsonObject = { [key: string]: FiveEPlayJson };

export type FiveEPlayErrorCode =
  | 'INVALID_INPUT'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'MATCH_NOT_FOUND'
  | 'INVALID_RESPONSE'
  | 'REALTIME_CONNECTION_FAILED'
  | 'SESSION_CLOSED'
  | 'INTERNAL_ERROR';

export type FiveEPlayOperation = 'match-detail' | 'match-realtime' | 'live-matches';

export type FiveEPlayStage =
  | 'validating-input'
  | 'fetching-match'
  | 'fetching-analysis'
  | 'fetching-logs'
  | 'fetching-community'
  | 'fetching-live-matches'
  | 'building-output'
  | 'connecting-realtime'
  | 'streaming-realtime'
  | 'completed';

export interface FiveEPlayProgressEvent {
  operation: FiveEPlayOperation;
  stage: FiveEPlayStage;
  message: string;
  timestamp: string;
}

export interface FiveEPlayRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  includeAnalysis?: boolean;
  includeCommunityRatings?: boolean;
  includeLogs?: boolean;
  onProgress?: (event: FiveEPlayProgressEvent) => void;
}

export interface FiveEPlayClientOptions {
  fetch?: typeof globalThis.fetch;
  webSocketFactory?: FiveEPlayWebSocketFactory;
}

export type GetFiveEPlayMatchOptions = FiveEPlayClientOptions & FiveEPlayRequestOptions;
export type CreateFiveEPlayMatchSessionOptions = FiveEPlayClientOptions & FiveEPlayRequestOptions;

export interface GetFiveEPlayLiveMatchesOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: FiveEPlayProgressEvent) => void;
}

export interface FiveEPlayMatchIdentity {
  id: string;
  numericId: number;
  url: string;
}

export type FiveEPlayMatchStatus = 'upcoming' | 'live' | 'completed' | 'unknown';
export type FiveEPlayMapStatus = 'upcoming' | 'live' | 'completed' | 'unknown';
export type FiveEPlaySide = 'CT' | 'T';

export interface FiveEPlayTournament {
  id: string | null;
  name: string;
  logoUrl: string | null;
  status: string | null;
  grade: string | null;
  gradeLabel: string | null;
  location: string | null;
  prize: string | null;
  startsAt: string | null;
  endsAt: string | null;
  color: string | null;
}

export interface FiveEPlayTeam {
  id: string;
  name: string;
  logoUrl: string | null;
  country: string | null;
  rank: number | null;
  valveRank: number | null;
  seriesScore: number | null;
  quickScore: number | null;
  odds: number | null;
  oddsPercent: number | null;
}

export interface FiveEPlayVetoEntry {
  order: number;
  action: 'ban' | 'pick' | 'left' | 'unknown';
  teamId: string | null;
  map: string;
  iconUrl: string | null;
  backgroundUrl: string | null;
}

export interface FiveEPlayHalfScore {
  side: FiveEPlaySide | null;
  score: number | null;
  roundResults: number[];
}

export interface FiveEPlayTeamMapState {
  teamId: string | null;
  currentSide: FiveEPlaySide | null;
  score: number | null;
  quickScore: number | null;
  firstHalf: FiveEPlayHalfScore;
  secondHalf: FiveEPlayHalfScore;
  overtime: FiveEPlayHalfScore;
  flags: string[];
}

export interface FiveEPlayPlayerEquipment {
  health: number | null;
  money: number | null;
  armor: boolean | null;
  helmet: boolean | null;
  defuseKit: boolean | null;
  alive: boolean | null;
  weapon: string | null;
  weaponLogoUrl: string | null;
}

export interface FiveEPlayPlayerMetrics {
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  kdRatio: number | null;
  kdDifference: number | null;
  rating: number | null;
  kastRate: number | null;
  adr: number | null;
  killsPerRound: number | null;
  deathsPerRound: number | null;
  impact: number | null;
  multiKillRating: number | null;
  roundSwingRate: number | null;
  headshots: number | null;
  headshotRate: number | null;
  firstKills: number | null;
  firstDeaths: number | null;
  firstKillRate: number | null;
  flashAssists: number | null;
  tradedDeaths: number | null;
  clutchWins: number | null;
  roundMvp: number | null;
  multiKills: { two: number | null; three: number | null; four: number | null; five: number | null };
  clutches: { oneVsOne: number | null; oneVsTwo: number | null; oneVsThree: number | null; oneVsFour: number | null; oneVsFive: number | null };
}

export interface FiveEPlayPlayerStats {
  id: string;
  name: string;
  countryLogoUrl: string | null;
  portraitUrl: string | null;
  halfPortraitUrl: string | null;
  equipment: FiveEPlayPlayerEquipment;
  metrics: FiveEPlayPlayerMetrics;
  versusKills: Record<string, number>;
  firstKillsByOpponent: Record<string, number>;
}

export interface FiveEPlayTeamPlayerStats {
  teamId: string;
  overall: FiveEPlayPlayerStats[];
  ct: FiveEPlayPlayerStats[];
  t: FiveEPlayPlayerStats[];
}

export interface FiveEPlayPlayerDuel {
  playerId: string;
  opponentPlayerId: string;
  kills: number;
}

export interface FiveEPlayRoundStart {
  round: number | null;
  map: string | null;
  mapNumber: number | null;
}

export interface FiveEPlayRoundEnd {
  ctScore: number | null;
  tScore: number | null;
  winnerSide: FiveEPlaySide | null;
  reason: string | null;
  reasonCode: number | null;
}

export interface FiveEPlayLogPlayer {
  id: string | null;
  name: string;
  side: FiveEPlaySide | null;
}

export interface FiveEPlayKillEvent {
  eventId: string | null;
  killer: FiveEPlayLogPlayer;
  victim: FiveEPlayLogPlayer;
  assister: FiveEPlayLogPlayer | null;
  flasher: FiveEPlayLogPlayer | null;
  weapon: string | null;
  weaponLogoUrl: string | null;
  headshot: boolean;
  wallbang: boolean;
  throughSmoke: boolean;
  noScope: boolean;
  killerBlind: boolean;
  killerPosition: { x: number | null; y: number | null };
  victimPosition: { x: number | null; y: number | null };
}

export interface FiveEPlayBombEvent {
  player: FiveEPlayLogPlayer;
  site: string | null;
  ctPlayers: number | null;
  tPlayers: number | null;
}

export interface FiveEPlayLogEvent {
  updateVersion: string;
  matchId: string;
  tournamentId: string | null;
  mapId: string | null;
  mapNumber: number | null;
  map: string | null;
  type: number | null;
  kind:
    | 'round-start'
    | 'round-end'
    | 'player-joined'
    | 'player-left'
    | 'bomb-planted'
    | 'bomb-defused'
    | 'kill'
    | 'suicide'
    | 'match-started'
    | 'restart'
    | 'unknown';
  roundStart: FiveEPlayRoundStart | null;
  roundEnd: FiveEPlayRoundEnd | null;
  playerJoined: FiveEPlayLogPlayer | null;
  playerLeft: FiveEPlayLogPlayer | null;
  kill: FiveEPlayKillEvent | null;
  suicide: { player: FiveEPlayLogPlayer; weapon: string | null; weaponLogoUrl: string | null } | null;
  bombPlanted: FiveEPlayBombEvent | null;
  bombDefused: FiveEPlayLogPlayer | null;
  restart: FiveEPlayJson | null;
}

export interface FiveEPlayMap {
  id: string;
  number: number;
  label: string;
  name: string;
  status: FiveEPlayMapStatus;
  display: boolean;
  pickedByTeamId: string | null;
  pickAction: 'pick' | 'left' | 'unknown';
  resultTeamId: string | null;
  iconUrl: string | null;
  backgroundUrl: string | null;
  startedAtUnixSeconds: number | null;
  endedAtUnixSeconds: number | null;
  currentRound: number | null;
  roundStage: string | null;
  gameTimeSeconds: number | null;
  roundStartedAtUnixSeconds: number | null;
  bombPlanted: boolean;
  bombPlantedAtUnixSeconds: number | null;
  teams: FiveEPlayTeamMapState[];
  playerStats: FiveEPlayTeamPlayerStats[];
  playerDuels: FiveEPlayPlayerDuel[];
  highlights: FiveEPlayJsonObject[];
  milestones: FiveEPlayJsonObject[];
  eventLog: {
    order: 'chronological';
    complete: boolean;
    fromVersion: string | null;
    toVersion: string | null;
    events: FiveEPlayLogEvent[];
  };
}

export interface FiveEPlayAnalysisPlayer {
  id: string;
  name: string;
  country: string | null;
  countryLogoUrl: string | null;
  logoUrl: string | null;
  halfPortraitUrl: string | null;
  rating: number | null;
  kdRatio: number | null;
  kastRate: number | null;
  adr: number | null;
  killsPerRound: number | null;
  impact: number | null;
  multiKillRating: number | null;
  roundSwingRate: number | null;
}

export interface FiveEPlayAnalysisMap {
  id: string | null;
  name: string;
  localizedName: string | null;
  iconUrl: string | null;
  backgroundUrl: string | null;
  bpType: string | null;
  teams: Array<{
    teamId: string;
    matches: number | null;
    wins: number | null;
    winRate: number | null;
    picks: number | null;
    pickRate: number | null;
    bans: number | null;
    banRate: number | null;
  }>;
}

export interface FiveEPlayRecentMatchTeam {
  id: string;
  name: string;
  score: number;
}

export interface FiveEPlayRecentMatchReference {
  id: string;
  numericId: number;
  url: string;
  status: 'completed';
  playedAtUnixSeconds: number;
  teams: [FiveEPlayRecentMatchTeam, FiveEPlayRecentMatchTeam];
  winnerTeamId: string | null;
}

export interface FiveEPlayTeamRecentMatches {
  teamId: string;
  sourceCount: number;
  invalidReferenceCount: number;
  matches: FiveEPlayRecentMatchReference[];
}

export interface FiveEPlayPrematchAnalysis {
  hidden: boolean;
  teams: Array<{
    teamId: string;
    winRate: number | null;
    rating: number | null;
    kdRatio: number | null;
    firstHalfPistolWinRate: number | null;
    secondHalfPistolWinRate: number | null;
    players: FiveEPlayAnalysisPlayer[];
  }>;
  maps: FiveEPlayAnalysisMap[];
  playerPower: Array<{ teamId: string; players: FiveEPlayJsonObject[] }>;
  recentMatches: FiveEPlayTeamRecentMatches[];
  headToHead: {
    teamWinRates: Array<{ teamId: string; winRate: number | null }>;
    matches: FiveEPlayJsonObject[];
  };
}

export interface FiveEPlayCommunityScore {
  average: number | null;
  userCount: number;
  text: string | null;
  starCounts: number[];
  starPercentages: Array<number | null>;
}

export interface FiveEPlayCommunityCard {
  tab: string;
  contentType: string | null;
  id: string;
  name: string;
  logoUrl: string | null;
  teamLogoUrl: string | null;
  countryLogoUrl: string | null;
  detail: string | null;
  positions: string[];
  content: string[];
  score: FiveEPlayCommunityScore;
  starLabels: string[];
}

export interface FiveEPlayCommunityRatings {
  tabs: Array<{
    tab: string;
    id: string;
    name: string;
    logoUrl: string | null;
    selected: boolean;
    cards: FiveEPlayCommunityCard[];
  }>;
}

export interface FiveEPlayMatch {
  schemaVersion: '1.0.0';
  capturedAt: string;
  sport: 'cs2';
  source: { provider: '5eplay'; url: string };
  stateVersion: string | null;
  match: {
    id: string;
    numericId: number;
    status: FiveEPlayMatchStatus;
    version: string | null;
    bestOf: number | null;
    scheduledAtUnixSeconds: number | null;
    stage: string | null;
    stageDescription: string | null;
    seriesScore: Array<{ teamId: string; score: number | null }>;
  };
  tournament: FiveEPlayTournament;
  teams: FiveEPlayTeam[];
  veto: FiveEPlayVetoEntry[];
  maps: FiveEPlayMap[];
  current: FiveEPlayMap | null;
  analysis: FiveEPlayPrematchAnalysis | null;
  communityRatings: FiveEPlayCommunityRatings | null;
}

export interface FiveEPlayRequestDiagnostic {
  kind: 'match' | 'analysis' | 'log' | 'community-tabs' | 'community-list' | 'live-list';
  status: number;
  durationMs: number;
  bytes: number | null;
  mapNumber?: number;
  tab?: string;
  page?: number;
}

export interface FiveEPlayDiagnosticWarning {
  code: string;
  reason: string;
  section?: string;
  mapNumber?: number;
}

export interface FiveEPlayMatchDiagnostics {
  schemaVersion: '1.0.0';
  operation: 'match-detail';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  input: FiveEPlayMatchIdentity;
  requests: FiveEPlayRequestDiagnostic[];
  warnings: FiveEPlayDiagnosticWarning[];
}

export interface GetFiveEPlayMatchResult {
  data: FiveEPlayMatch;
  diagnostics: FiveEPlayMatchDiagnostics;
}

export interface FiveEPlayLiveMatchTeam {
  id: string;
  name: string;
  country: string | null;
  rank: number | null;
  valveRank: number | null;
  seriesScore: number | null;
}

export interface FiveEPlayLiveMatchMap {
  id: string;
  number: number;
  name: string;
  status: FiveEPlayMapStatus;
  winnerTeamId: string | null;
  teams: Array<{ teamId: string; score: number | null }>;
}

export interface FiveEPlayLiveMatch {
  id: string;
  numericId: number;
  url: string;
  status: 'live';
  bestOf: number | null;
  scheduledAtUnixSeconds: number | null;
  stage: string | null;
  stageDescription: string | null;
  tournament: {
    id: string | null;
    name: string;
    grade: string | null;
    gradeLabel: string | null;
  };
  teams: FiveEPlayLiveMatchTeam[];
  maps: FiveEPlayLiveMatchMap[];
  currentMap: FiveEPlayLiveMatchMap | null;
}

export interface FiveEPlayLiveMatchesData {
  schemaVersion: '1.0.0';
  capturedAt: string;
  source: { provider: '5eplay'; url: 'https://event.5eplay.com/csgo/matches' };
  hasLiveMatches: boolean;
  matches: FiveEPlayLiveMatch[];
}

export interface FiveEPlayLiveMatchesDiagnostics {
  schemaVersion: '1.0.0';
  operation: 'live-matches';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  requests: FiveEPlayRequestDiagnostic[];
}

export interface GetFiveEPlayLiveMatchesResult {
  data: FiveEPlayLiveMatchesData;
  diagnostics: FiveEPlayLiveMatchesDiagnostics;
}

export type FiveEPlayRealtimeUpdate =
  | { type: 'snapshot'; capturedAt: string; snapshot: FiveEPlayMatch }
  | { type: 'state'; capturedAt: string; stateVersion: string | null; snapshot: FiveEPlayMatch }
  | { type: 'log'; capturedAt: string; event: FiveEPlayLogEvent; snapshot: FiveEPlayMatch };

export interface FiveEPlayMatchSession extends AsyncIterable<FiveEPlayRealtimeUpdate>, AsyncDisposable {
  readonly id: string;
  readonly initial: GetFiveEPlayMatchResult;
  snapshot(): FiveEPlayMatch;
  close(): Promise<void>;
}

export interface FiveEPlayWebSocketLike {
  binaryType: BinaryType;
  readyState: number;
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: EventListener): void;
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: EventListener): void;
  send(data: ArrayBufferView | ArrayBuffer | Blob | string): void;
  close(code?: number, reason?: string): void;
}

export type FiveEPlayWebSocketFactory = (
  url: string,
  protocols: string[],
) => FiveEPlayWebSocketLike;
