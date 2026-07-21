declare const unixMillisecondsBrand: unique symbol;
declare const confirmedRevisionBrand: unique symbol;

export type UnixMilliseconds = number & {
  readonly [unixMillisecondsBrand]: 'UnixMilliseconds';
};

export type ConfirmedRevision = string & {
  readonly [confirmedRevisionBrand]: 'ConfirmedRevision';
};

export type MatchFormat = 'bo1' | 'bo3';
export type MapNumber = 1 | 2 | 3;
export type MapStage = 'first-half' | 'second-half' | 'overtime';
export type MatchLifecycle = 'scheduled' | 'live' | 'closing' | 'closed';
export type ClosureKind = 'normal' | 'administrative';
export type VetoAction = 'ban' | 'pick' | 'left' | 'unknown';

export type MatchPhase =
  | { readonly kind: 'prestart' }
  | { readonly kind: 'map-unopened'; readonly mapNumber: MapNumber }
  | { readonly kind: 'map-live'; readonly mapNumber: MapNumber }
  | {
      readonly kind: 'between-maps';
      readonly previousMapNumber: MapNumber;
      readonly nextMapNumber: MapNumber;
    }
  | { readonly kind: 'series-ended'; readonly finalMapNumber: MapNumber };

export type MatchState =
  | {
      readonly certainty: 'confirmed';
      readonly lifecycle: 'scheduled';
      readonly phase: { readonly kind: 'prestart' };
      readonly closure: null;
      readonly dataFinality: 'provisional';
    }
  | {
      readonly certainty: 'confirmed';
      readonly lifecycle: 'live';
      readonly phase: Exclude<MatchPhase, { readonly kind: 'prestart' | 'series-ended' }>;
      readonly closure: null;
      readonly dataFinality: 'provisional';
    }
  | {
      readonly certainty: 'confirmed';
      readonly lifecycle: 'closing';
      readonly phase: Extract<MatchPhase, { readonly kind: 'series-ended' }>;
      readonly closure: ClosureKind;
      readonly dataFinality: 'provisional';
    }
  | {
      readonly certainty: 'confirmed';
      readonly lifecycle: 'closed';
      readonly phase: Extract<MatchPhase, { readonly kind: 'series-ended' }>;
      readonly closure: ClosureKind;
      readonly dataFinality: 'stable';
    };

export type ProviderGlobalStatusCode = 0 | 1 | 2;
export type ProviderBoutStatusCode = -1 | 1 | 2;

export interface ProviderBoutState {
  readonly providerBoutNumber: number;
  readonly statusCode: ProviderBoutStatusCode;
}

export interface ProviderMatchState {
  readonly globalStatusCode: ProviderGlobalStatusCode;
  readonly bouts: readonly ProviderBoutState[];
}

export interface TeamIdentity {
  readonly id: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly country: string | null;
  readonly rank: number | null;
  readonly virtualRank: number | null;
  readonly virtualRankChange: number | null;
  readonly virtualRankTrend: 'up' | 'down' | null;
}

export interface TeamScore {
  readonly teamId: string;
  readonly score: number;
}

export interface MapTeamState {
  readonly teamId: string;
  readonly score: number | null;
  readonly firstHalfScore: number | null;
  readonly secondHalfScore: number | null;
  readonly overtimeScore: number | null;
  readonly currentSide: 'CT' | 'T' | null;
  readonly money: number | null;
  readonly equipmentValue: number | null;
  readonly quickScore: number | null;
  readonly firstHalfSide: 'CT' | 'T' | null;
  readonly secondHalfSide: 'CT' | 'T' | null;
  readonly overtimeSide: 'CT' | 'T' | null;
  readonly firstHalfRounds: readonly number[];
  readonly secondHalfRounds: readonly number[];
  readonly overtimeRounds: readonly number[];
  readonly flags: readonly string[];
}

export interface PlayerState {
  readonly id: string;
  readonly teamId: string;
  readonly name: string;
  readonly kills: number | null;
  readonly deaths: number | null;
  readonly assists: number | null;
  readonly headshots: number | null;
  readonly rating: number | null;
  readonly adr: number | null;
  readonly kastPercent: number | null;
  readonly health: number | null;
  readonly money: number | null;
  readonly equipment: readonly string[];
  readonly weaponLogoUrl: string | null;
  readonly portraitUrl: string | null;
  readonly countryLogoUrl: string | null;
  readonly alive: boolean | null;
  readonly hasArmor: boolean | null;
  readonly helmet: boolean | null;
  readonly hasDefuseKit: boolean | null;
  readonly damagePerRound: number | null;
  readonly deathsPerRound: number | null;
  readonly killsPerRound: number | null;
  readonly killDeathRatio: number | null;
  readonly impact: number | null;
  readonly multiKillRating: number | null;
  readonly swingPercent: number | null;
  readonly firstKills: number | null;
  readonly firstDeaths: number | null;
  readonly openingKillPercent: number | null;
  readonly openingKillDifference: number | null;
  readonly killDeathDifference: number | null;
  readonly headshotPercent: number | null;
  readonly flashAssists: number | null;
  readonly clutchWins: number | null;
  readonly multiKillCount: number | null;
  readonly tradedDeaths: number | null;
  readonly roundMvpCount: number | null;
  readonly halfPortraitUrl: string | null;
  readonly killsByOpponent: PlayerDuelRows;
  readonly openingKillsByOpponent: PlayerDuelRows;
  readonly multiKills: readonly {
    readonly kills: 2 | 3 | 4 | 5;
    readonly rounds: number | null;
  }[];
}

export interface PlayerDuelStat {
  readonly opponentPlayerId: string;
  readonly kills: number;
  readonly providerMarkedMost: boolean | null;
}

export type PlayerDuelRows =
  | {
      readonly status: 'present';
      readonly rows: readonly PlayerDuelStat[];
      readonly gap: null;
    }
  | {
      readonly status: 'empty';
      readonly rows: readonly [];
      readonly gap: null;
    }
  | {
      readonly status: 'partial';
      readonly rows: readonly PlayerDuelStat[];
      readonly gap: 'PROVIDER_LIST_MISSING';
    }
  | {
      readonly status: 'unavailable';
      readonly rows: null;
      readonly gap:
        | 'FIELD_MISSING'
        | 'SCHEMA_UNSUPPORTED'
        | 'SOURCE_CONFLICT'
        | 'OPPONENT_ROSTER_UNAVAILABLE';
    };

export type PlayerStatRows =
  | {
      readonly status: 'present';
      readonly rows: readonly PlayerState[];
      readonly gap: null;
    }
  | {
      readonly status: 'empty';
      readonly rows: readonly [];
      readonly gap: null;
    }
  | {
      readonly status: 'unavailable';
      readonly rows: null;
      readonly gap:
        | 'FIELD_MISSING'
        | 'SCHEMA_UNSUPPORTED'
        | 'TIMELINE_INCOHERENT'
        | 'NON_OFFICIAL_ACTIVITY';
    };

export interface TeamPlayerStatistics {
  readonly teamId: string;
  readonly overall: PlayerStatRows;
  readonly ct: PlayerStatRows;
  readonly t: PlayerStatRows;
}

export interface PlayerStatHighlightMetric {
  readonly providerValueType: string;
  readonly title: string;
  readonly values: readonly [string | null, string | null];
}

export interface PlayerStatHighlight {
  readonly title: string;
  readonly leaders: readonly [
    { readonly teamId: string; readonly playerId: string | null },
    { readonly teamId: string; readonly playerId: string | null },
  ];
  readonly metrics: readonly PlayerStatHighlightMetric[];
}

export type PlayerStatHighlights =
  | {
      readonly status: 'present';
      readonly rows: readonly PlayerStatHighlight[];
      readonly gap: null;
    }
  | {
      readonly status: 'empty';
      readonly rows: readonly [];
      readonly gap: null;
    }
  | {
      readonly status: 'unavailable';
      readonly rows: null;
      readonly gap: 'FIELD_MISSING' | 'SCHEMA_UNSUPPORTED' | 'NON_OFFICIAL_ACTIVITY';
    };

export interface PlayerStatistics {
  readonly teams: readonly [TeamPlayerStatistics, TeamPlayerStatistics];
  readonly highlights: PlayerStatHighlights;
}

export type UnplayedPlayerStatRows = Exclude<
  PlayerStatRows,
  { readonly status: 'present' }
>;
export type UnplayedPlayerStatHighlights = Exclude<
  PlayerStatHighlights,
  { readonly status: 'present' }
>;
export interface UnplayedTeamPlayerStatistics {
  readonly teamId: string;
  readonly overall: UnplayedPlayerStatRows;
  readonly ct: UnplayedPlayerStatRows;
  readonly t: UnplayedPlayerStatRows;
}
export interface UnplayedPlayerStatistics {
  readonly teams: readonly [
    UnplayedTeamPlayerStatistics,
    UnplayedTeamPlayerStatistics,
  ];
  readonly highlights: UnplayedPlayerStatHighlights;
}

export interface MvpChartMetric {
  readonly key: 'adr' | 'deaths-per-round' | 'kill-death-ratio' | 'kills-per-round';
  readonly averageReference: number | null;
  readonly upperReference: number | null;
  readonly displayPercent: number | null;
  readonly normalizedDisplay: number | null;
}

export interface SeriesPlayerStatistics extends PlayerStatistics {
  readonly mvp: PlayerState | null;
  readonly mvpChart: readonly MvpChartMetric[];
}

interface MatchMapMetadata {
  readonly mapNumber: MapNumber;
  readonly providerBoutNumber: number;
  readonly orderFinality: 'confirmed' | 'provisional';
  readonly name: string | null;
  readonly displayName: string | null;
  readonly iconUrl: string | null;
  readonly backgroundUrl: string | null;
  readonly regulationRoundsPerHalf: number | null;
  readonly vetoAction: VetoAction | null;
  readonly vetoTeamId: string | null;
}

export interface UnplayedMapTeamState {
  readonly teamId: string;
  readonly score: number | null;
  readonly firstHalfScore: null;
  readonly secondHalfScore: null;
  readonly overtimeScore: null;
  readonly currentSide: null;
  readonly money: null;
  readonly equipmentValue: null;
  readonly quickScore: number | null;
  readonly firstHalfSide: null;
  readonly secondHalfSide: null;
  readonly overtimeSide: null;
  readonly firstHalfRounds: readonly [];
  readonly secondHalfRounds: readonly [];
  readonly overtimeRounds: readonly [];
  readonly flags: readonly [];
}

export type UnopenedMapTeamState = UnplayedMapTeamState & {
  readonly score: null;
  readonly quickScore: null;
};

export type AwardedWinnerMapTeamState = UnplayedMapTeamState & {
  readonly score: 1;
};

export type AwardedLoserMapTeamState = UnplayedMapTeamState & {
  readonly score: 0;
};

export type AwardedMapTeamState =
  | AwardedWinnerMapTeamState
  | AwardedLoserMapTeamState;

export type UnusedClosedMapTeamState = UnplayedMapTeamState & {
  readonly score: null;
  readonly quickScore: null;
};

interface UnplayedMapProcess {
  readonly stage: null;
  readonly startedAt: null;
  readonly endedAt: null;
  readonly currentRound: null;
  readonly roundStartedAt: null;
  readonly gameTimeSeconds: null;
  readonly bombPlantedAt: null;
  readonly playerStatistics: UnplayedPlayerStatistics;
}

interface LiveMapProcess {
  readonly stage: MapStage;
  readonly startedAt: UnixMilliseconds | null;
  readonly endedAt: null;
  readonly currentRound: number;
  readonly roundStartedAt: UnixMilliseconds | null;
  readonly gameTimeSeconds: number | null;
  readonly bombPlantedAt: UnixMilliseconds | null;
  readonly teams: readonly [MapTeamState, MapTeamState];
  readonly playerStatistics: PlayerStatistics;
}

interface SettledMapProcess extends Omit<LiveMapProcess, 'endedAt' | 'startedAt'> {
  readonly startedAt: UnixMilliseconds;
  readonly endedAt: UnixMilliseconds;
}

export type MatchMap =
  | (MatchMapMetadata &
      UnplayedMapProcess & {
        readonly status: 'unopened';
        readonly settled: false;
        readonly played: false;
        readonly closedWithoutPlay: false;
        readonly technicalDisposition: null;
        readonly teams: readonly [UnopenedMapTeamState, UnopenedMapTeamState];
        readonly winnerTeamId: null;
      })
  | (MatchMapMetadata &
      LiveMapProcess & {
        readonly status: 'live';
        readonly settled: false;
        readonly played: true;
        readonly closedWithoutPlay: false;
        readonly technicalDisposition: null;
        readonly winnerTeamId: null;
      })
  | (MatchMapMetadata &
      SettledMapProcess & {
        readonly status: 'settled';
        readonly settled: true;
        readonly played: true;
        readonly closedWithoutPlay: false;
        readonly technicalDisposition: null;
        readonly winnerTeamId: string;
      })
  | (MatchMapMetadata &
      UnplayedMapProcess & {
        readonly status: 'closed-without-play';
        readonly settled: true;
        readonly played: false;
        readonly closedWithoutPlay: true;
        readonly technicalDisposition: 'awarded';
        readonly teams:
          | readonly [AwardedWinnerMapTeamState, AwardedLoserMapTeamState]
          | readonly [AwardedLoserMapTeamState, AwardedWinnerMapTeamState];
        readonly winnerTeamId: string;
      })
  | (MatchMapMetadata &
      UnplayedMapProcess & {
        readonly status: 'closed-without-play';
        readonly settled: true;
        readonly played: false;
        readonly closedWithoutPlay: true;
        readonly technicalDisposition: 'unused';
        readonly teams: readonly [UnusedClosedMapTeamState, UnusedClosedMapTeamState];
        readonly winnerTeamId: null;
      });

export interface MatchIdentity {
  readonly id: string;
  readonly format: MatchFormat;
  readonly gameVersion: 'cs2';
  readonly scheduledAt: UnixMilliseconds | null;
}

export interface Tournament {
  readonly id: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly stage: string | null;
  readonly stageDescription: string | null;
  readonly location: string | null;
  readonly prize: string | null;
  readonly gradeCode: string | null;
  readonly gradeLabel: string | null;
  readonly status: string | null;
  readonly providerLocalStartTime: string | null;
  readonly providerLocalEndTime: string | null;
}

export interface VetoEntry {
  readonly action: VetoAction;
  readonly mapName: string | null;
  readonly mapIconUrl: string | null;
  readonly mapLogoUrl: string | null;
  readonly teamId: string | null;
}

export type SectionStatus =
  | 'complete'
  | 'empty'
  | 'partial'
  | 'unavailable'
  | 'not-applicable';

interface DataSectionMetadata {
  readonly observedAt: UnixMilliseconds;
  readonly attempts: number;
}

export type DataSection<T> =
  | (DataSectionMetadata & {
      readonly status: 'complete' | 'empty';
      readonly data: T;
      readonly gap: null;
    })
  | (DataSectionMetadata & {
      readonly status: 'partial';
      readonly data: T;
      readonly gap: string;
    })
  | (DataSectionMetadata & {
      readonly status: 'unavailable';
      readonly data: null;
      readonly gap: string;
    })
  | (DataSectionMetadata & {
      readonly status: 'not-applicable';
      readonly data: null;
      readonly gap: null;
    });

export interface MatchEvent {
  readonly matchId: string;
  readonly providerBoutId: string | null;
  readonly providerBoutNumber: number | null;
  readonly mapNumber: MapNumber | null;
  readonly mapName: string | null;
  readonly tournamentId: string | null;
  readonly updateVersion: string;
  readonly type: string;
  readonly occurredAt: UnixMilliseconds | null;
  readonly summary: string | null;
  readonly evidenceRef: string | null;
  readonly roundNumber: number | null;
  readonly actorPlayerId: string | null;
  readonly targetPlayerId: string | null;
  readonly teamId: string | null;
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AnalysisPlayer {
  readonly id: string;
  readonly name: string;
  readonly portraitUrl: string | null;
  readonly country: string | null;
  readonly countryLogoUrl: string | null;
  readonly rating: number | null;
  readonly killDeathRatio: number | null;
  readonly kastPercent: number | null;
  readonly adr: number | null;
  readonly killsPerRound: number | null;
  readonly impact: number | null;
  readonly multiKillRating: number | null;
  readonly swing: number | null;
}

export interface AnalysisTeam {
  readonly teamId: string;
  readonly winRate: number | null;
  readonly rating: number | null;
  readonly killDeathRatio: number | null;
  readonly firstSideRate: number | null;
  readonly secondSideRate: number | null;
  readonly players: readonly AnalysisPlayer[];
}

export interface AnalysisMapTeam {
  readonly teamId: string;
  readonly matches: number | null;
  readonly wins: number | null;
  readonly winRate: number | null;
  readonly picks: number | null;
  readonly pickRate: number | null;
  readonly bans: number | null;
  readonly banRate: number | null;
}

export interface AnalysisMap {
  readonly id: string | null;
  readonly name: string;
  readonly localizedName: string | null;
  readonly iconUrl: string | null;
  readonly backgroundUrl: string | null;
  readonly vetoAction: VetoAction;
  readonly vetoTeamId: string | null;
  readonly teams: readonly [AnalysisMapTeam, AnalysisMapTeam];
}

export interface PlayerPowerMetric {
  readonly key: string;
  readonly name: string;
  readonly iconUrl: string | null;
  readonly score: string | null;
  readonly guideline: string | null;
  readonly width: number | null;
  readonly children: readonly PlayerPowerMetric[];
}

export interface PlayerPower {
  readonly playerId: string;
  readonly playerName: string;
  readonly teamId: string | null;
  readonly teamName: string | null;
  readonly teamLogoUrl: string | null;
  readonly portraitUrl: string | null;
  readonly country: string | null;
  readonly countryLogoUrl: string | null;
  readonly side: string | null;
  readonly sideLabel: string | null;
  readonly timeFrameCode: string | null;
  readonly hltvRating: number | null;
  readonly hidden: boolean;
  readonly metrics: readonly PlayerPowerMetric[];
}

export interface HistoricalTeam {
  readonly id: string;
  readonly name: string;
  readonly logoUrl: string | null;
}

export interface HistoricalTournament {
  readonly id: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly stage: string | null;
  readonly stageDescription: string | null;
  readonly coverUrl: string | null;
  readonly location: string | null;
  readonly prize: string | null;
  readonly gradeCode: string | null;
  readonly gradeLabel: string | null;
  readonly status: string | null;
  readonly providerLocalStartTime: string | null;
  readonly providerLocalEndTime: string | null;
}

export interface HistoricalMatch {
  readonly id: string;
  readonly format: string;
  readonly scheduledAt: UnixMilliseconds | null;
  readonly lifecycle: string | null;
  readonly providerStatusCode: string | null;
  readonly gradeCode: string | null;
  readonly teams: readonly [HistoricalTeam, HistoricalTeam];
  readonly scores: readonly [
    { readonly teamId: string; readonly score: number | null },
    { readonly teamId: string; readonly score: number | null },
  ];
  readonly winnerTeamId: string | null;
  readonly mapWinners: readonly (string | null)[];
  readonly tournament: HistoricalTournament | null;
}

export interface MatchAnalysis {
  readonly stateVersion: string;
  readonly tournament: HistoricalTournament;
  readonly teams: readonly [AnalysisTeam, AnalysisTeam];
  readonly maps: readonly AnalysisMap[];
  readonly power: readonly [readonly PlayerPower[], readonly PlayerPower[]];
  readonly recentMatches: readonly {
    readonly teamId: string;
    readonly matches: readonly HistoricalMatch[];
  }[];
  readonly headToHead: {
    readonly winRates: readonly [
      { readonly teamId: string; readonly winRate: number | null },
      { readonly teamId: string; readonly winRate: number | null },
    ];
    readonly matches: readonly HistoricalMatch[];
  };
}

export interface TeamRecentMatches {
  readonly teamId: string;
  readonly totalPages: number;
  readonly totalRows: number;
  readonly winRate: number | null;
  readonly winStreak: number | null;
  readonly tournaments: readonly {
    readonly tournament: HistoricalTournament;
    readonly matches: readonly HistoricalMatch[];
  }[];
}

export interface TeamPastMatches {
  readonly teamId: string;
  readonly totalPages: number;
  readonly totalRows: number;
  readonly gamesPlayed: number | null;
  readonly winRate: number | null;
  readonly winStreak: number | null;
  readonly matches: readonly HistoricalMatch[];
}

export interface CommunityTab {
  readonly tab: string;
  readonly id: string;
  readonly name: string;
  readonly logoUrl: string | null;
}

export interface CommunityCard {
  readonly tab: string;
  readonly id: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly teamLogoUrl: string | null;
  readonly countryLogoUrl: string | null;
  readonly detail: string | null;
  readonly positions: readonly string[];
  readonly content: readonly string[];
  readonly averageScore: number | null;
  readonly userCount: number | null;
  readonly scoreText: string | null;
}

export interface CommunityData {
  readonly tabs: readonly CommunityTab[];
  readonly cards: readonly CommunityCard[];
}

export interface MatchDetails {
  readonly events: DataSection<readonly MatchEvent[]>;
  readonly analysis: DataSection<MatchAnalysis>;
  readonly teamRecentMatches: DataSection<readonly TeamRecentMatches[]>;
  readonly teamPastMatches: DataSection<readonly TeamPastMatches[]>;
  readonly community: DataSection<CommunityData>;
}

export interface MatchFreshness {
  readonly coreObservedAt: UnixMilliseconds;
  readonly stateVersion: string;
  readonly localVersion: number;
}

export interface ConfirmedMatchObservation {
  readonly schema: 'fiveeplay-match/v3';
  readonly revision: ConfirmedRevision;
  readonly observedAt: UnixMilliseconds;
  readonly match: MatchIdentity;
  readonly state: MatchState;
  readonly teams: readonly [TeamIdentity, TeamIdentity];
  readonly tournament: Tournament;
  readonly seriesScore: readonly [TeamScore, TeamScore];
  readonly seriesWinnerTeamId: string | null;
  readonly maps: readonly MatchMap[];
  readonly providerState: ProviderMatchState;
  readonly seriesPlayerStatistics: SeriesPlayerStatistics;
  readonly veto: readonly VetoEntry[];
  readonly freshness: MatchFreshness;
}

export interface MatchSnapshot extends ConfirmedMatchObservation {
  readonly detailsCompleteness: 'complete' | 'partial';
  readonly details: MatchDetails;
}

export type BlockedReason =
  | 'initializing'
  | 'resyncing'
  | 'inconsistent-state'
  | 'version-gap'
  | 'stale-http'
  | 'realtime-unavailable'
  | 'provider-unavailable';

export type UnsupportedReason =
  | 'format-not-supported'
  | 'format-unverified'
  | 'provider-schema-unsupported';

export type MatchSnapshotResult =
  | { readonly kind: 'confirmed'; readonly snapshot: MatchSnapshot }
  | {
      readonly kind: 'blocked';
      readonly matchId: string;
      readonly reason: BlockedReason;
      readonly observedAt: UnixMilliseconds;
    }
  | { readonly kind: 'not-found'; readonly matchId: string }
  | {
      readonly kind: 'unsupported';
      readonly matchId: string;
      readonly reason: UnsupportedReason;
      readonly format: string | null;
    }
  | {
      readonly kind: 'superseded';
      readonly matchId: string;
      readonly expectedRevision: ConfirmedRevision | null;
      readonly observedRevision: ConfirmedRevision;
    };

export type MatchUpdate =
  | {
      readonly kind: 'confirmed-state';
      readonly observation: ConfirmedMatchObservation;
    }
  | {
      readonly kind: 'provisional-telemetry';
      readonly matchId: string;
      readonly observedAt: UnixMilliseconds;
      readonly revision: ConfirmedRevision | null;
      readonly telemetry: ProvisionalTelemetry;
    }
  | {
      readonly kind: 'blocked';
      readonly matchId: string;
      readonly reason: BlockedReason;
      readonly observedAt: UnixMilliseconds;
      readonly lastConfirmed: ConfirmedMatchObservation | null;
    }
  | {
      readonly kind: 'not-found';
      readonly matchId: string;
    }
  | {
      readonly kind: 'unsupported';
      readonly matchId: string;
      readonly reason: UnsupportedReason;
      readonly format: string | null;
    };

export interface ProvisionalTelemetry {
  readonly source: 'state-topic' | 'event-topic';
  readonly eventName: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly providerBoutNumbers: readonly number[];
  readonly eventType: string | null;
}

export interface MatchWatch extends AsyncIterable<MatchUpdate>, AsyncDisposable {
  current(): ConfirmedMatchObservation | null;
}

export interface EventLimits {
  readonly maxPages?: number;
  readonly maxEvents?: number;
}

export interface SnapshotOptions {
  readonly expectedRevision?: ConfirmedRevision;
  readonly deadlineMs?: number;
  readonly eventLimits?: EventLimits;
  readonly signal?: AbortSignal;
}

export interface ScheduleOptions {
  readonly page?: number;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

export interface ScheduleTeam {
  readonly id: string | null;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly country: string | null;
  readonly rank: number | null;
  readonly virtualRank: number | null;
  readonly seriesScore: number;
}

export interface ScheduleMapTeam {
  readonly teamId: string;
  readonly score: number | null;
}

export interface ScheduleMap {
  readonly mapNumber: number;
  readonly name: string | null;
  readonly status: 'unopened' | 'live' | 'settled';
  readonly teams: readonly [ScheduleMapTeam, ScheduleMapTeam];
  readonly winnerTeamId: string | null;
}

export interface ScheduleTournament {
  readonly id: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly coverUrl: string | null;
  readonly location: string | null;
  readonly prize: string | null;
  readonly gradeCode: string | null;
  readonly gradeLabel: string | null;
  readonly providerStatus: string | null;
  readonly providerLocalStartTime: string | null;
  readonly providerLocalEndTime: string | null;
}

export interface ScheduleMatch {
  readonly id: string;
  readonly url: string;
  readonly bestOf: number | null;
  readonly scheduledAt: UnixMilliseconds | null;
  readonly status: 'live' | 'upcoming';
  readonly teams: readonly [ScheduleTeam, ScheduleTeam];
  readonly tournament: ScheduleTournament;
  readonly stage: string | null;
  readonly stageDescription: string | null;
  readonly maps: readonly ScheduleMap[];
  readonly currentMapNumber: number | null;
}

export interface SchedulePage {
  readonly schema: 'fiveeplay-schedule/v1';
  readonly observedAt: UnixMilliseconds;
  readonly providerStateVersion: string | null;
  readonly page: number;
  readonly pageSize: 20;
  readonly sourceCount: number;
  readonly mayHaveNextPage: boolean;
  readonly matches: readonly ScheduleMatch[];
}

export type SchedulePageResult =
  | { readonly kind: 'available'; readonly schedule: SchedulePage }
  | {
      readonly kind: 'blocked';
      readonly page: number;
      readonly observedAt: UnixMilliseconds;
      readonly reason: 'provider-unavailable' | 'provider-schema-unsupported';
    };

export interface WatchOptions {
  readonly signal?: AbortSignal;
}

export interface SourceTimingOptions {
  readonly coreDeadlineMs?: number;
  readonly detailDeadlineMs?: number;
  readonly eventDeadlineMs?: number;
  readonly prestartPollMs?: number;
  readonly nearStartPollMs?: number;
  readonly livePollMs?: number;
  readonly prestartMaxAgeMs?: number;
  readonly nearStartMaxAgeMs?: number;
  readonly liveMaxAgeMs?: number;
  readonly closeCalibrationMs?: number;
  readonly reconnectInitialMs?: number;
  readonly realtimeHandshakeMs?: number;
}

export interface SourceLimitOptions {
  readonly eventPages?: number;
  readonly events?: number;
  readonly eventPageSize?: number;
  readonly teamHistoryPages?: number;
}

export interface DiagnosticEvent {
  readonly code: string;
  readonly severity: 'debug' | 'info' | 'warning' | 'error';
  readonly matchId: string | null;
  readonly message: string;
  readonly observedAt: UnixMilliseconds;
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
}

export interface EvidenceRecord {
  readonly kind: string;
  readonly matchId: string;
  readonly observedAt: UnixMilliseconds;
  readonly evidenceRef: string;
  readonly payload: unknown;
}

export interface FiveEPlayMatchSourceOptions {
  readonly timing?: SourceTimingOptions;
  readonly limits?: SourceLimitOptions;
  readonly onDiagnostic?: (event: DiagnosticEvent) => void | Promise<void>;
  readonly evidenceSink?: (record: EvidenceRecord) => void | Promise<void>;
}

export interface FiveEPlayMatchSource {
  schedule(options?: ScheduleOptions): Promise<SchedulePageResult>;
  snapshot(matchId: string, options?: SnapshotOptions): Promise<MatchSnapshotResult>;
  watch(matchId: string, options?: WatchOptions): MatchWatch;
}
