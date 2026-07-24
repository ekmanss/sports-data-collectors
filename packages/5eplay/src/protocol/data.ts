import type {
  AwardedLoserMapTeamState,
  AwardedWinnerMapTeamState,
  ConfirmedMatchObservation,
  MapNumber,
  MapTeamState,
  MatchMap,
  MatchSnapshot,
  MatchState,
  MvpChartMetric,
  PlayerDuelStat,
  PlayerDuelRows,
  PlayerStatHighlight,
  PlayerStatHighlightMetric,
  PlayerStatHighlights,
  PlayerStatRows,
  PlayerState,
  PlayerStatistics,
  SeriesPlayerStatistics,
  TeamIdentity,
  TeamPlayerStatistics,
  TeamScore,
  Tournament,
  UnopenedMapTeamState,
  UnusedClosedMapTeamState,
  UnplayedPlayerStatistics,
  UnplayedMapTeamState,
  VetoEntry,
} from '../domain/model.js';
import {
  asArray,
  asRecord,
  asString,
  deepFreeze,
  integer,
  nullableNumber,
  nullableString,
  secondsToMilliseconds,
  unixMilliseconds,
} from '../internal/value.js';
import { revisionFor } from '../domain/revision.js';

export interface DecodedCore {
  readonly snapshot: ConfirmedMatchObservation;
}

export class InconsistentProviderStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InconsistentProviderStateError';
  }
}

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

export class UnsupportedFormatError extends Error {
  readonly format: string;
  readonly reason: 'format-not-supported' | 'format-unverified' | 'participants-unresolved';

  constructor(
    format: string,
    reason: 'format-not-supported' | 'format-unverified' | 'participants-unresolved',
  ) {
    super(`unsupported provider format ${format}`);
    this.name = 'UnsupportedFormatError';
    this.format = format;
    this.reason = reason;
  }
}

function team(info: unknown, label: string): TeamIdentity {
  const value = asRecord(info, label);
  const virtualRank = value.v_rank === undefined ? null : asRecord(value.v_rank, `${label}.v_rank`);
  const virtualRankTrend = virtualRank === null ? null : nullableString(virtualRank.trend);
  return {
    country: nullableString(value.country),
    id: asString(value.id, `${label}.id`),
    logoUrl: nullableString(value.logo),
    name: asString(value.disp_name, `${label}.disp_name`),
    rank: nullableNumber(value.rank),
    virtualRank: virtualRank === null ? null : nullableNumber(virtualRank.rank),
    virtualRankChange: virtualRank === null ? null : nullableNumber(virtualRank.change),
    virtualRankTrend:
      virtualRankTrend === 'up' || virtualRankTrend === 'down' ? virtualRankTrend : null,
  };
}

function providerBoolean(value: unknown): boolean | null {
  if (value === true || value === '1' || value === 1) return true;
  if (value === false || value === '0' || value === 0 || value === '2' || value === 2) {
    return false;
  }
  return null;
}

function providerNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const number = nullableNumber(value);
  if (number === null) throw new TypeError(`${label} must be numeric or empty`);
  return number;
}

function providerSeconds(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null;
  if (nullableNumber(value) === null) throw new TypeError(`${label} must be numeric or empty`);
  return secondsToMilliseconds(value);
}

function mapTeamState(
  value: unknown,
  teamId: string,
  allowMissingIdentity: boolean,
): MapTeamState {
  const stats = asRecord(value, 'map team stats');
  const providerId = asString(stats.id, 'map team stats.id');
  if (providerId === '' && !allowMissingIdentity) {
    throw new InconsistentProviderStateError('started or settled map team identity is missing');
  }
  if (providerId !== '' && providerId !== teamId) {
    throw new InconsistentProviderStateError('map team identity mismatch');
  }
  const side = nullableString(stats.role);
  const providerSide = (value: unknown): 'CT' | 'T' | null =>
    value === 'CT' || value === 'T' ? value : null;
  const roundValues = (value: unknown): readonly number[] =>
    asArray(value, 'map team round data').map((entry, index) => {
      const number = providerNumber(entry, `map team round data[${index}]`);
      if (number === null) throw new TypeError('map team round data cannot contain empty values');
      return number;
    });
  return {
    currentSide: side === 'CT' || side === 'T' ? side : null,
    equipmentValue: providerNumber(stats.equipment_value, 'map team equipment_value'),
    firstHalfRounds: roundValues(stats.fh_data),
    firstHalfSide: providerSide(stats.fh_role),
    firstHalfScore: providerNumber(stats.fh_score, 'map team fh_score'),
    flags: asArray(stats.flags, 'map team flags').map((entry, index) =>
      asString(entry, `map team flags[${index}]`),
    ),
    money: providerNumber(stats.money, 'map team money'),
    overtimeScore: providerNumber(stats.ot_score, 'map team ot_score'),
    overtimeRounds: roundValues(stats.ot_data),
    overtimeSide: providerSide(stats.ot_role),
    quickScore: providerNumber(stats.quick_score, 'map team quick_score'),
    score: providerNumber(stats.all_score, 'map team all_score'),
    secondHalfScore: providerNumber(stats.sh_score, 'map team sh_score'),
    secondHalfRounds: roundValues(stats.sh_data),
    secondHalfSide: providerSide(stats.sh_role),
    teamId,
  };
}

function providerPercent(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && /^nan%?$/i.test(value.trim())) return null;
  const normalized = typeof value === 'string' ? value.replace(/%$/, '') : value;
  return providerNumber(normalized, label);
}

function normalizedCorePlayerId(value: unknown): string | null {
  const id = nullableString(value);
  if (id === null) return null;
  if (/^csgo_pl_[1-9]\d*$/.test(id)) return id;
  return /^[1-9]\d*$/.test(id) ? `csgo_pl_${id}` : null;
}

function duelStats(
  player: Record<string, unknown>,
  listKey: 'counter_kills' | 'first_kills',
  mapKey: 'counter_kill_map' | 'first_kill_map',
  opponentPlayerIds: ReadonlySet<string> | null,
  allowMapFallback: boolean,
): PlayerDuelRows {
  const listValue = player[listKey];
  const mapValue = player[mapKey];
  if (
    (listValue === undefined || listValue === null) &&
    (mapValue === undefined || mapValue === null)
  ) {
    return { gap: 'FIELD_MISSING', rows: null, status: 'unavailable' };
  }
  try {
    const list = asArray(listValue, `player.${listKey}`).map((entry, index) => {
      const duel = asRecord(entry, `player.${listKey}[${index}]`);
      const opponentPlayerId = normalizedCorePlayerId(duel.player_id);
      const kills = providerNumber(duel.kill, `player.${listKey}[${index}].kill`);
      const providerMarkedMost = providerBoolean(duel.most_kill);
      if (opponentPlayerId === null || kills === null || providerMarkedMost === null) {
        throw new TypeError(`player.${listKey}[${index}] is invalid`);
      }
      return { kills, opponentPlayerId, providerMarkedMost } satisfies PlayerDuelStat;
    });
    const map = asRecord(mapValue, `player.${mapKey}`);
    const mapEntries = Object.entries(map).map(([id, value]) => {
      const opponentPlayerId = normalizedCorePlayerId(id);
      const kills = providerNumber(value, `player.${mapKey}.${id}`);
      if (opponentPlayerId === null || kills === null) {
        throw new TypeError(`player.${mapKey}.${id} is invalid`);
      }
      return [opponentPlayerId, kills] as const;
    });
    const mapValues = new Map(mapEntries);
    if (mapValues.size !== mapEntries.length) {
      return { gap: 'SOURCE_CONFLICT', rows: null, status: 'unavailable' };
    }
    if (list.length === 0 && mapValues.size === 0) {
      return { gap: null, rows: [], status: 'empty' };
    }
    if (opponentPlayerIds === null) {
      return {
        gap: 'OPPONENT_ROSTER_UNAVAILABLE',
        rows: null,
        status: 'unavailable',
      };
    }
    const listIds = new Set(list.map((entry) => entry.opponentPlayerId));
    if (
      listIds.size !== list.length ||
      list.some((entry) => !opponentPlayerIds.has(entry.opponentPlayerId)) ||
      mapEntries.some(([opponentPlayerId]) => !opponentPlayerIds.has(opponentPlayerId))
    ) {
      return { gap: 'SOURCE_CONFLICT', rows: null, status: 'unavailable' };
    }
    if (list.length === 0 && mapValues.size > 0 && allowMapFallback) {
      return {
        gap: 'PROVIDER_LIST_MISSING',
        rows: mapEntries.map(([opponentPlayerId, kills]) => ({
          kills,
          opponentPlayerId,
          providerMarkedMost: null,
        })),
        status: 'partial',
      };
    }
    if (
      mapValues.size !== list.length ||
      list.some((entry) => mapValues.get(entry.opponentPlayerId) !== entry.kills) ||
      mapEntries.some(([opponentPlayerId]) => !listIds.has(opponentPlayerId))
    ) {
      return { gap: 'SOURCE_CONFLICT', rows: null, status: 'unavailable' };
    }
    return { gap: null, rows: list, status: 'present' };
  } catch {
    return { gap: 'SCHEMA_UNSUPPORTED', rows: null, status: 'unavailable' };
  }
}

function playerState(
  value: unknown,
  teamId: string,
  opponentPlayerIds: ReadonlySet<string> | null,
  allowDuelMapFallback = false,
): PlayerState {
  const player = asRecord(value, 'player');
  const weapon = nullableString(player.weapon);
  const health = providerNumber(player.hp, 'player.hp');
  const clutchWins = providerNumber(player.cl_win_num, 'player.cl_win_num');
  const finalVictoryCount = providerNumber(
    player.final_victory_num,
    'player.final_victory_num',
  );
  if (
    clutchWins !== null &&
    finalVictoryCount !== null &&
    clutchWins !== finalVictoryCount
  ) {
    throw new TypeError('player clutch counters disagree');
  }
  const id = asString(player.id, 'player.id');
  if (id.length === 0) throw new TypeError('player.id cannot be empty');
  return {
    alive: health === null ? null : health > 0,
    adr: providerNumber(player.adr, 'player.adr'),
    assists: providerNumber(player.assist, 'player.assist'),
    clutchWins: clutchWins ?? finalVictoryCount,
    countryLogoUrl: nullableString(player.country_logo),
    damagePerRound: providerNumber(player.adr, 'player.adr'),
    deaths: providerNumber(player.death, 'player.death'),
    deathsPerRound: providerNumber(player.dpr, 'player.dpr'),
    equipment: weapon === null ? [] : [weapon],
    firstDeaths: providerNumber(player.first_death_num, 'player.first_death_num'),
    firstKills: providerNumber(player.first_blood_num, 'player.first_blood_num'),
    flashAssists: providerNumber(player.flash_assist, 'player.flash_assist'),
    halfPortraitUrl: nullableString(player.half_portrait),
    hasArmor: providerBoolean(player.kevlar),
    hasDefuseKit: providerBoolean(player.has_defusekit),
    headshotPercent: providerPercent(player.head_shot_rate, 'player.head_shot_rate'),
    headshots: providerNumber(player.headshot, 'player.headshot'),
    health,
    helmet: providerBoolean(player.helmet),
    id,
    impact: providerNumber(player.impact, 'player.impact'),
    kastPercent: providerPercent(player.kast, 'player.kast'),
    killDeathDifference: providerNumber(player.kd_diff, 'player.kd_diff'),
    killDeathRatio: providerNumber(player.kd_rate, 'player.kd_rate'),
    kills: providerNumber(player.kill, 'player.kill'),
    killsByOpponent: duelStats(
      player,
      'counter_kills',
      'counter_kill_map',
      opponentPlayerIds,
      allowDuelMapFallback,
    ),
    killsPerRound: providerNumber(player.kpr, 'player.kpr'),
    money: providerNumber(player.money, 'player.money'),
    multiKillCount: providerNumber(player.more_kill, 'player.more_kill'),
    multiKillRating: providerNumber(player.mk_rating, 'player.mk_rating'),
    multiKills: [
      { kills: 2, rounds: providerNumber(player.k2, 'player.k2') },
      { kills: 3, rounds: providerNumber(player.k3, 'player.k3') },
      { kills: 4, rounds: providerNumber(player.k4, 'player.k4') },
      { kills: 5, rounds: providerNumber(player.k5, 'player.k5') },
    ],
    name: asString(player.name, 'player.name'),
    openingKillDifference: providerNumber(player.fkdiff, 'player.fkdiff'),
    openingKillPercent: providerPercent(player.first_blood_rate, 'player.first_blood_rate'),
    openingKillsByOpponent: duelStats(
      player,
      'first_kills',
      'first_kill_map',
      opponentPlayerIds,
      allowDuelMapFallback,
    ),
    portraitUrl: nullableString(player.portrait),
    rating: providerNumber(player.rating, 'player.rating'),
    roundMvpCount: providerNumber(player.round_mvp, 'player.round_mvp'),
    swingPercent: providerPercent(player.swing, 'player.swing'),
    teamId,
    tradedDeaths: providerNumber(player.traded_death, 'player.traded_death'),
    weaponLogoUrl: nullableString(player.weapon_logo),
  };
}

function playerRosterIds(value: unknown): ReadonlySet<string> | null {
  if (!Array.isArray(value)) return null;
  try {
    const ids = value.map((entry, index) => {
      const id = asString(asRecord(entry, `player roster[${index}]`).id, 'player roster id');
      if (id.length === 0) throw new TypeError('player roster id cannot be empty');
      return id;
    });
    return new Set(ids).size === ids.length ? new Set(ids) : null;
  } catch {
    return null;
  }
}

function playerStates(
  value: unknown,
  teamId: string,
  opponentPlayerIds: ReadonlySet<string> | null,
): readonly PlayerState[] {
  const rows = asArray(value, 'player stats').map((entry) =>
    playerState(entry, teamId, opponentPlayerIds),
  );
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new TypeError('player stats contain duplicate IDs');
  }
  return rows;
}

function playerStatRows(
  value: unknown,
  teamId: string,
  opponentPlayerIds: ReadonlySet<string> | null,
): PlayerStatRows {
  if (value === undefined) {
    return { gap: 'FIELD_MISSING', rows: null, status: 'unavailable' };
  }
  try {
    const rows = playerStates(value, teamId, opponentPlayerIds);
    return rows.length === 0
      ? { gap: null, rows: [], status: 'empty' }
      : { gap: null, rows, status: 'present' };
  } catch {
    return { gap: 'SCHEMA_UNSUPPORTED', rows: null, status: 'unavailable' };
  }
}

function playerStatHighlights(
  value: unknown,
  teamIds: readonly [string, string],
): PlayerStatHighlights {
  if (value === undefined) {
    return { gap: 'FIELD_MISSING', rows: null, status: 'unavailable' };
  }
  try {
    const rows = asArray(value, 'player stat highlights').map((entry, index) => {
      const highlight = asRecord(entry, `player stat highlight[${index}]`);
      const metrics = asArray(
        highlight.data,
        `player stat highlight[${index}].data`,
      ).map((metricValue, metricIndex) => {
        const metric = asRecord(
          metricValue,
          `player stat highlight[${index}].data[${metricIndex}]`,
        );
        const textValue = (input: unknown): string | null =>
          input === undefined || input === null || input === '' ? null : String(input);
        return {
          providerValueType: asString(metric.value_type, 'player highlight value_type'),
          title: asString(metric.title, 'player highlight metric title'),
          values: [textValue(metric.t1_data), textValue(metric.t2_data)] as const,
        } satisfies PlayerStatHighlightMetric;
      });
      return {
        leaders: [
          { playerId: nullableString(highlight.t1_player_id), teamId: teamIds[0] },
          { playerId: nullableString(highlight.t2_player_id), teamId: teamIds[1] },
        ],
        metrics,
        title: asString(highlight.title, 'player stat highlight title'),
      } satisfies PlayerStatHighlight;
    });
    return rows.length === 0
      ? { gap: null, rows: [], status: 'empty' }
      : { gap: null, rows, status: 'present' };
  } catch {
    return { gap: 'SCHEMA_UNSUPPORTED', rows: null, status: 'unavailable' };
  }
}

function playerStatistics(
  container: Record<string, unknown>,
  teamIds: readonly [string, string],
  prefixes: readonly [string, string],
): PlayerStatistics {
  const plane = (suffix: '' | '_ct' | '_t'): readonly [PlayerStatRows, PlayerStatRows] => {
    const firstValue = container[`${prefixes[0]}${suffix}`];
    const secondValue = container[`${prefixes[1]}${suffix}`];
    return [
      playerStatRows(firstValue, teamIds[0], playerRosterIds(secondValue)),
      playerStatRows(secondValue, teamIds[1], playerRosterIds(firstValue)),
    ];
  };
  const overall = plane('');
  const ct = plane('_ct');
  const t = plane('_t');
  const team = (index: 0 | 1): TeamPlayerStatistics => ({
    ct: ct[index],
    overall: overall[index],
    t: t[index],
    teamId: teamIds[index],
  });
  return {
    highlights: playerStatHighlights(container.pr_stats, teamIds),
    teams: [team(0), team(1)],
  };
}

function timelineCoherentPlayerStatistics(
  statistics: PlayerStatistics,
  observedRound: number,
): PlayerStatistics {
  const roundBudget = observedRound + 1;
  const sanitize = (slice: PlayerStatRows): PlayerStatRows => {
    if (slice.rows === null || slice.status === 'empty') return slice;
    const kills = slice.rows.reduce((total, row) => total + (row.kills ?? 0), 0);
    const deaths = slice.rows.reduce((total, row) => total + (row.deaths ?? 0), 0);
    const coherent =
      slice.rows.every(
        (row) =>
          (row.deaths === null || (row.deaths >= 0 && row.deaths <= roundBudget)) &&
          (row.kills === null || (row.kills >= 0 && row.kills <= roundBudget * 5)),
      ) &&
      kills <= roundBudget * 5 &&
      deaths <= roundBudget * 5;
    return coherent
      ? slice
      : { gap: 'TIMELINE_INCOHERENT', rows: null, status: 'unavailable' };
  };
  return {
    ...statistics,
    teams: statistics.teams.map((team) => ({
      ...team,
      ct: sanitize(team.ct),
      overall: sanitize(team.overall),
      t: sanitize(team.t),
    })) as [TeamPlayerStatistics, TeamPlayerStatistics],
  };
}

function nonOfficialPlayerStatistics(
  statistics: PlayerStatistics,
): UnplayedPlayerStatistics {
  const isolate = (slice: PlayerStatRows) =>
    slice.status === 'present'
      ? { gap: 'NON_OFFICIAL_ACTIVITY' as const, rows: null, status: 'unavailable' as const }
      : slice;
  const team = (value: TeamPlayerStatistics) => ({
    ...value,
    ct: isolate(value.ct),
    overall: isolate(value.overall),
    t: isolate(value.t),
  });
  return {
    highlights:
      statistics.highlights.status === 'present'
        ? {
            gap: 'NON_OFFICIAL_ACTIVITY',
            rows: null,
            status: 'unavailable',
          }
        : statistics.highlights,
    teams: [team(statistics.teams[0]), team(statistics.teams[1])],
  };
}

function assertUnplayedPlayerStatistics(
  statistics: PlayerStatistics,
): asserts statistics is UnplayedPlayerStatistics {
  if (
    statistics.highlights.status === 'present' ||
    statistics.teams.some((team) =>
      [team.overall, team.ct, team.t].some((slice) => slice.status === 'present'),
    )
  ) {
    throw new InconsistentProviderStateError('unplayed map contains player statistics');
  }
}

function seriesPlayerStatistics(
  globalState: Record<string, unknown>,
  teamIds: readonly [string, string],
): SeriesPlayerStatistics {
  const statistics = playerStatistics(
    globalState,
    teamIds,
    ['t1_player_stats', 't2_player_stats'],
  );
  const playerIds = statistics.teams.map((team) =>
    new Set(
      [team.overall, team.ct, team.t].flatMap((slice) =>
        slice.rows === null ? [] : slice.rows.map((row) => row.id),
      ),
    ),
  ) as [Set<string>, Set<string>];
  let mvp: PlayerState | null = null;
  const mvpValue = globalState.mvp_player_stats;
  if (mvpValue !== undefined) {
    try {
      const mvpRecord = asRecord(mvpValue, 'mvp_player_stats');
      const mvpId = nullableString(mvpRecord.id);
      if (mvpId !== null) {
        const memberships = playerIds.map((ids) => ids.has(mvpId));
        if (memberships.filter(Boolean).length !== 1) {
          throw new TypeError('MVP player identity is not unique to one team');
        }
        mvp = playerState(
          mvpRecord,
          memberships[0] ? teamIds[0] : teamIds[1],
          memberships[0] ? playerIds[1] : playerIds[0],
          true,
        );
      }
    } catch {
      mvp = null;
    }
  }
  const chartInputs = [
    ['adr', 'adr'],
    ['deaths-per-round', 'dpr'],
    ['kill-death-ratio', 'kd_rate'],
    ['kills-per-round', 'kpr'],
  ] as const;
  let mvpChart: readonly MvpChartMetric[] = [];
  try {
    const average = asRecord(globalState.avg_player_stats, 'avg_player_stats');
    const upper = asRecord(globalState.max_player_stats, 'max_player_stats');
    const display = asRecord(globalState.bar_chart_player_stats, 'bar_chart_player_stats');
    const decodedChart = chartInputs.map(([key, providerKey]) => ({
      averageReference: providerNumber(average[providerKey], `average.${providerKey}`),
      displayPercent: providerNumber(display[providerKey], `display.${providerKey}`),
      key,
      normalizedDisplay: providerNumber(display[`new_${providerKey}`], `display.new_${providerKey}`),
      upperReference: providerNumber(upper[providerKey], `upper.${providerKey}`),
    }));
    mvpChart = decodedChart.some((metric) =>
      metric.averageReference !== null ||
      metric.upperReference !== null ||
      metric.displayPercent !== null ||
      metric.normalizedDisplay !== null,
    ) ? decodedChart : [];
  } catch {
    mvpChart = [];
  }
  return { ...statistics, mvp, mvpChart };
}

function assertInactiveTeam(team: MapTeamState): void {
  if (
    team.currentSide !== null ||
    team.equipmentValue !== null ||
    team.firstHalfScore !== null ||
    team.firstHalfSide !== null ||
    team.money !== null ||
    team.overtimeScore !== null ||
    team.overtimeSide !== null ||
    team.secondHalfScore !== null ||
    team.secondHalfSide !== null ||
    team.firstHalfRounds.length > 0 ||
    team.secondHalfRounds.length > 0 ||
    team.overtimeRounds.length > 0 ||
    team.flags.length > 0
  ) {
    throw new InconsistentProviderStateError('unplayed map contains gameplay team data');
  }
}

function isNoPlayTeam(team: MapTeamState): boolean {
  const zeroOrMissing = (value: number | null): boolean => value === null || value === 0;
  return !(
    team.currentSide !== null ||
    team.equipmentValue !== null ||
    !zeroOrMissing(team.firstHalfScore) ||
    team.firstHalfSide !== null ||
    team.money !== null ||
    !zeroOrMissing(team.overtimeScore) ||
    team.overtimeSide !== null ||
    !zeroOrMissing(team.secondHalfScore) ||
    team.secondHalfSide !== null ||
    team.firstHalfRounds.some((round) => round !== 0) ||
    team.secondHalfRounds.some((round) => round !== 0) ||
    team.overtimeRounds.some((round) => round !== 0) ||
    team.flags.length > 0
  );
}

function assertNoPlayTeam(team: MapTeamState): void {
  if (!isNoPlayTeam(team)) {
    throw new InconsistentProviderStateError('no-play map contains official gameplay team data');
  }
}

function inactiveTeam(team: MapTeamState, preserveAwardScore: false): UnopenedMapTeamState;
function inactiveTeam(team: MapTeamState, preserveAwardScore: true): UnplayedMapTeamState;
function inactiveTeam(
  team: MapTeamState,
  preserveAwardScore: boolean,
): UnplayedMapTeamState {
  return {
    currentSide: null,
    equipmentValue: null,
    firstHalfRounds: [],
    firstHalfScore: null,
    firstHalfSide: null,
    flags: [],
    money: null,
    overtimeRounds: [],
    overtimeScore: null,
    overtimeSide: null,
    quickScore: preserveAwardScore ? team.quickScore : null,
    score: preserveAwardScore ? team.score : null,
    secondHalfRounds: [],
    secondHalfScore: null,
    secondHalfSide: null,
    teamId: team.teamId,
  };
}

function awardedWinnerTeam(team: MapTeamState): AwardedWinnerMapTeamState {
  if (team.score !== 1) {
    throw new InconsistentProviderStateError('awarded map winner does not have a 1-0 score');
  }
  return {
    ...inactiveTeam(team, true),
    score: 1,
  };
}

function awardedLoserTeam(team: MapTeamState): AwardedLoserMapTeamState {
  if (team.score !== 0) {
    throw new InconsistentProviderStateError('awarded map loser does not have a 1-0 score');
  }
  return {
    ...inactiveTeam(team, true),
    score: 0,
  };
}

function unusedTeam(team: MapTeamState): UnusedClosedMapTeamState {
  return inactiveTeam(team, false);
}

function assertActiveTeamScore(team: MapTeamState): void {
  const values = [team.score, team.firstHalfScore, team.secondHalfScore];
  if (values.some((value) => value === null || !Number.isInteger(value) || value < 0)) {
    throw new InconsistentProviderStateError('played map has missing or invalid team scores');
  }
  if (
    team.quickScore !== null &&
    (!Number.isInteger(team.quickScore) || team.quickScore < 0)
  ) {
    throw new InconsistentProviderStateError('played map has an invalid quick score');
  }
  if (
    team.overtimeScore !== null &&
    (!Number.isInteger(team.overtimeScore) || team.overtimeScore < 0)
  ) {
    throw new InconsistentProviderStateError('played map has an invalid overtime score');
  }
  const expected =
    (team.firstHalfScore ?? 0) +
    (team.secondHalfScore ?? 0) +
    (team.overtimeScore ?? 0);
  if (team.score !== expected) {
    throw new InconsistentProviderStateError('played map score breakdown is inconsistent');
  }
}

function map(
  value: unknown,
  mapNumber: MapNumber,
  providerBoutNumber: number,
  orderFinality: 'confirmed' | 'provisional',
  teamIds: readonly [string, string],
  forceUnopened = false,
): MatchMap {
  const bout = asRecord(value, `provider bout ${providerBoutNumber}`);
  const number = integer(bout.bout_num, `provider bout ${providerBoutNumber}.bout_num`);
  if (number !== providerBoutNumber) throw new TypeError('provider bout identity changed');
  const statusCode = integer(bout.status, `provider bout ${providerBoutNumber}.status`);
  if (statusCode !== -1 && statusCode !== 1 && statusCode !== 2) {
    throw new InconsistentProviderStateError(`unsupported map status ${statusCode}`);
  }
  const startedAt = providerSeconds(
    bout.start_time,
    `provider bout ${providerBoutNumber}.start_time`,
  );
  const result = nullableString(bout.result);
  const resultWinnerTeamId =
    result === 't1'
      ? teamIds[0]
      : result === 't2'
        ? teamIds[1]
        : null;
  const stage = nullableString(bout.curr_bout_stage);
  const normalizedStage: MatchMap['stage'] =
    stage === 'fh'
      ? 'first-half'
      : stage === 'sh'
        ? 'second-half'
        : stage === 'ot'
          ? 'overtime'
          : null;
  const providerVeto = nullableString(bout.bp_act);
  const vetoAction: MatchMap['vetoAction'] =
    providerVeto === 'left'
      ? 'left'
      : providerVeto === 't1_pick' || providerVeto === 't2_pick'
        ? 'pick'
        : providerVeto === null
          ? null
          : 'unknown';
  const vetoTeamId =
    providerVeto === 't1_pick'
      ? teamIds[0]
      : providerVeto === 't2_pick'
        ? teamIds[1]
        : null;
  const endedAt = providerSeconds(
    bout.end_time,
    `provider bout ${providerBoutNumber}.end_time`,
  );
  const currentRound = providerNumber(
    bout.curr_round_num,
    `provider bout ${providerBoutNumber}.curr_round_num`,
  );
  const roundStartedAt = providerSeconds(
    bout.round_start_time,
    `provider bout ${providerBoutNumber}.round_start_time`,
  );
  const gameTimeSeconds = providerNumber(
    bout.game_time,
    `provider bout ${providerBoutNumber}.game_time`,
  );
  const bombPlantedAt = providerSeconds(
    bout.bomb_planted_time,
    `provider bout ${providerBoutNumber}.bomb_planted_time`,
  );
  const statistics = playerStatistics(
    bout,
    teamIds,
    ['t1_pr_stats', 't2_pr_stats'],
  );
  const teams = [
    mapTeamState(bout.t1_stats, teamIds[0], statusCode === -1),
    mapTeamState(bout.t2_stats, teamIds[1], statusCode === -1),
  ] as const;
  const expectedLegacyAwardScores =
    resultWinnerTeamId === teamIds[0]
      ? [1, 0] as const
      : resultWinnerTeamId === teamIds[1]
        ? [0, 1] as const
        : null;
  const legacyAwardedNoPlay =
    statusCode === -1 &&
    expectedLegacyAwardScores !== null &&
    startedAt === null &&
    endedAt === null &&
    currentRound === null &&
    roundStartedAt === null &&
    bombPlantedAt === null &&
    (gameTimeSeconds === null || gameTimeSeconds === 0) &&
    normalizedStage === null &&
    teams.every(
      (team, index) =>
        isNoPlayTeam(team) &&
        team.score === expectedLegacyAwardScores[index] &&
        (team.quickScore === null || team.quickScore === expectedLegacyAwardScores[index]),
    );
  const providerClosedWithoutPlay =
    (statusCode === 2 && startedAt === null) || legacyAwardedNoPlay;
  const providerWinnerTeamId =
    statusCode === 2 || legacyAwardedNoPlay ? resultWinnerTeamId : null;
  const metadata = {
    backgroundUrl: nullableString(bout.map_bgm),
    displayName: nullableString(bout.disp_name),
    iconUrl: nullableString(bout.map_icon),
    mapNumber,
    name: nullableString(bout.map_name),
    orderFinality,
    providerBoutNumber,
    regulationRoundsPerHalf: providerNumber(
      bout.round_num,
      `provider bout ${providerBoutNumber}.round_num`,
    ),
    vetoAction,
    vetoTeamId,
  };
  const phantomUnusedClosure =
    statusCode === 2 &&
    !providerClosedWithoutPlay &&
    result === null &&
    currentRound === null &&
    teams.every(
      (team) =>
        team.score === null &&
        team.quickScore === null &&
        team.firstHalfScore === null &&
        team.secondHalfScore === null &&
        team.overtimeScore === null &&
        team.firstHalfRounds.every((round) => round === 0) &&
        team.secondHalfRounds.every((round) => round === 0) &&
        team.overtimeRounds.every((round) => round === 0),
    );
  const closedWithoutPlay = providerClosedWithoutPlay || phantomUnusedClosure;
  if (forceUnopened) {
    return {
      ...metadata,
      bombPlantedAt: null,
      closedWithoutPlay: false,
      currentRound: null,
      endedAt: null,
      gameTimeSeconds: null,
      played: false,
      playerStatistics: nonOfficialPlayerStatistics(statistics),
      roundStartedAt: null,
      settled: false,
      stage: null,
      startedAt: null,
      status: 'unopened',
      teams: [inactiveTeam(teams[0], false), inactiveTeam(teams[1], false)],
      technicalDisposition: null,
      winnerTeamId: null,
    };
  }
  if (statusCode === -1 && !legacyAwardedNoPlay) {
    assertUnplayedPlayerStatistics(statistics);
    for (const team of teams) {
      assertInactiveTeam(team);
      if (team.score !== null || team.quickScore !== null) {
        throw new InconsistentProviderStateError('unopened map contains a score');
      }
    }
    if (
      startedAt !== null ||
      endedAt !== null ||
      currentRound !== null ||
      roundStartedAt !== null ||
      bombPlantedAt !== null ||
      (gameTimeSeconds !== null && gameTimeSeconds !== 0) ||
      normalizedStage !== null
    ) {
      throw new InconsistentProviderStateError('unopened map contains gameplay data');
    }
    return {
      ...metadata,
      bombPlantedAt: null,
      closedWithoutPlay: false,
      currentRound: null,
      endedAt: null,
      gameTimeSeconds: null,
      played: false,
      playerStatistics: statistics,
      roundStartedAt: null,
      settled: false,
      stage: null,
      startedAt: null,
      status: 'unopened',
      teams: [inactiveTeam(teams[0], false), inactiveTeam(teams[1], false)],
      technicalDisposition: null,
      winnerTeamId: null,
    };
  }
  if (statusCode === 1) {
    if (
      result !== null ||
      endedAt !== null ||
      currentRound === null ||
      !Number.isInteger(currentRound) ||
      currentRound <= 0 ||
      normalizedStage === null
    ) {
      throw new InconsistentProviderStateError('live map has contradictory lifecycle fields');
    }
    for (const team of teams) assertActiveTeamScore(team);
    return {
      ...metadata,
      bombPlantedAt,
      closedWithoutPlay: false,
      currentRound,
      endedAt: null,
      gameTimeSeconds,
      played: true,
      playerStatistics: timelineCoherentPlayerStatistics(statistics, currentRound),
      roundStartedAt,
      settled: false,
      stage: normalizedStage,
      startedAt,
      status: 'live',
      teams,
      technicalDisposition: null,
      winnerTeamId: null,
    };
  }
  if (closedWithoutPlay) {
    const nonOfficialStatistics = nonOfficialPlayerStatistics(statistics);
    for (const team of teams) assertNoPlayTeam(team);
    if (
      (providerClosedWithoutPlay && endedAt !== null) ||
      currentRound !== null ||
      roundStartedAt !== null ||
      bombPlantedAt !== null ||
      (gameTimeSeconds !== null && gameTimeSeconds !== 0) ||
      (normalizedStage !== null && normalizedStage !== 'first-half')
    ) {
      throw new InconsistentProviderStateError('technical map contains gameplay data');
    }
    if (providerWinnerTeamId === null) {
      if (
        result !== null ||
        teams.some((team) => team.score !== null || team.quickScore !== null)
      ) {
        throw new InconsistentProviderStateError('unused technical map contains a result');
      }
      return {
        ...metadata,
        bombPlantedAt: null,
        closedWithoutPlay: true,
        currentRound: null,
        endedAt: null,
        gameTimeSeconds: null,
        played: false,
        playerStatistics: nonOfficialStatistics,
        roundStartedAt: null,
        settled: true,
        stage: null,
        startedAt: null,
        status: 'closed-without-play',
        teams: [unusedTeam(teams[0]), unusedTeam(teams[1])],
        technicalDisposition: 'unused',
        winnerTeamId: null,
      };
    }
    const expectedScores = providerWinnerTeamId === teamIds[0] ? [1, 0] : [0, 1];
    if (
      teams.some(
        (team, index) =>
          team.score !== expectedScores[index],
      )
    ) {
      throw new InconsistentProviderStateError('awarded technical map is not a 1-0 award');
    }
    const awardedTeams = providerWinnerTeamId === teamIds[0]
      ? [awardedWinnerTeam(teams[0]), awardedLoserTeam(teams[1])] as const
      : [awardedLoserTeam(teams[0]), awardedWinnerTeam(teams[1])] as const;
    return {
      ...metadata,
      bombPlantedAt: null,
      closedWithoutPlay: true,
      currentRound: null,
      endedAt: null,
      gameTimeSeconds: null,
      played: false,
      playerStatistics: nonOfficialStatistics,
      roundStartedAt: null,
      settled: true,
      stage: null,
      startedAt: null,
      status: 'closed-without-play',
      teams: awardedTeams,
      technicalDisposition: 'awarded',
      winnerTeamId: providerWinnerTeamId,
    };
  }
  const scoreWinnerTeamId =
    teams[0].score !== null &&
    teams[1].score !== null &&
    teams[0].score !== teams[1].score
      ? teams[0].score > teams[1].score
        ? teamIds[0]
        : teamIds[1]
      : null;
  const winnerTeamId = providerWinnerTeamId ?? scoreWinnerTeamId;
  if (winnerTeamId === null) {
    throw new InconsistentProviderStateError('played settled map has no winner');
  }
  if (
    startedAt === null ||
    endedAt === null ||
    endedAt < startedAt ||
    currentRound === null ||
    !Number.isInteger(currentRound) ||
    currentRound <= 0 ||
    normalizedStage === null
  ) {
    throw new InconsistentProviderStateError('settled map has contradictory lifecycle fields');
  }
  for (const team of teams) assertActiveTeamScore(team);
  return {
    ...metadata,
    bombPlantedAt,
    closedWithoutPlay: false,
    currentRound,
    endedAt,
    gameTimeSeconds,
    played: true,
    playerStatistics: timelineCoherentPlayerStatistics(statistics, currentRound),
    roundStartedAt,
    settled: true,
    stage: normalizedStage,
    startedAt,
    status: 'settled',
    teams,
    technicalDisposition: null,
    winnerTeamId,
  };
}

type AwardedNoPlayMap = Extract<MatchMap, { technicalDisposition: 'awarded' }>;
type UnusedNoPlayMap = Extract<MatchMap, { technicalDisposition: 'unused' }>;

function awardUnusedMap(mapState: UnusedNoPlayMap, winnerTeamId: string): AwardedNoPlayMap {
  const [firstTeam, secondTeam] = mapState.teams;
  if (winnerTeamId === firstTeam.teamId) {
    return {
      ...mapState,
      orderFinality: 'confirmed',
      teams: [
        { ...firstTeam, score: 1 },
        { ...secondTeam, score: 0 },
      ],
      technicalDisposition: 'awarded',
      winnerTeamId,
    };
  }
  if (winnerTeamId === secondTeam.teamId) {
    return {
      ...mapState,
      orderFinality: 'confirmed',
      teams: [
        { ...firstTeam, score: 0 },
        { ...secondTeam, score: 1 },
      ],
      technicalDisposition: 'awarded',
      winnerTeamId,
    };
  }
  throw new InconsistentProviderStateError('inferred award winner is not a match participant');
}

function reconcileTerminalNoPlayAward(
  globalStatusCode: 0 | 1 | 2,
  maps: readonly MatchMap[],
  seriesScore: readonly [TeamScore, TeamScore],
): readonly MatchMap[] {
  const scoreValues = seriesScore.map((entry) => entry.score);
  if (
    globalStatusCode !== 2 ||
    Math.max(...scoreValues) !== 2 ||
    Math.min(...scoreValues) !== 1
  ) {
    return maps;
  }
  const unusedMaps = maps.filter(
    (entry): entry is UnusedNoPlayMap => entry.technicalDisposition === 'unused',
  );
  if (
    unusedMaps.length !== 1 ||
    !maps.every(
      (entry) =>
        entry === unusedMaps[0] ||
        (entry.status === 'settled' && entry.played),
    )
  ) {
    return maps;
  }
  const knownWinnerCounts = seriesScore.map(
    ({ teamId }) => maps.filter((entry) => entry.winnerTeamId === teamId).length,
  );
  const missingWins = seriesScore.map(
    ({ score }, index) => score - (knownWinnerCounts[index] ?? 0),
  );
  const missingWinnerIndex =
    missingWins[0] === 1 && missingWins[1] === 0
      ? 0
      : missingWins[0] === 0 && missingWins[1] === 1
        ? 1
        : null;
  if (missingWinnerIndex === null) return maps;

  const unusedMap = unusedMaps[0];
  const winnerTeamId = seriesScore[missingWinnerIndex]?.teamId;
  if (unusedMap === undefined || winnerTeamId === undefined) return maps;
  return maps.map(
    (entry) => entry === unusedMap ? awardUnusedMap(unusedMap, winnerTeamId) : entry,
  );
}

function stateFromEvidence(
  globalStatusCode: 0 | 1 | 2,
  maps: readonly MatchMap[],
  seriesScore: readonly [TeamScore, TeamScore],
  winsRequired: number,
): MatchState {
  const winnerCounts = new Map<string, number>();
  for (const entry of maps) {
    if (entry.settled && entry.played) {
      if (entry.winnerTeamId === null) {
        throw new InconsistentProviderStateError('played settled map has no winner');
      }
      const [first, second] = entry.teams;
      if (first.score === null || second.score === null || first.score === second.score) {
        throw new InconsistentProviderStateError('played settled map has no decisive final score');
      }
      const scoreWinner = first.score > second.score ? first.teamId : second.teamId;
      if (scoreWinner !== entry.winnerTeamId) {
        throw new InconsistentProviderStateError('settled map winner disagrees with final score');
      }
    }
    if (entry.winnerTeamId !== null) {
      winnerCounts.set(
        entry.winnerTeamId,
        (winnerCounts.get(entry.winnerTeamId) ?? 0) + 1,
      );
    }
  }
  if (
    (winnerCounts.get(seriesScore[0].teamId) ?? 0) !== seriesScore[0].score ||
    (winnerCounts.get(seriesScore[1].teamId) ?? 0) !== seriesScore[1].score
  ) {
    throw new InconsistentProviderStateError('series score does not match settled map results');
  }

  if (globalStatusCode === 0) {
    if (!maps.every((entry) => entry.status === 'unopened')) {
      throw new InconsistentProviderStateError('scheduled match contains started map evidence');
    }
    return {
      certainty: 'confirmed',
      closure: null,
      dataFinality: 'provisional',
      lifecycle: 'scheduled',
      phase: { kind: 'prestart' },
    };
  }

  if (globalStatusCode === 1) {
    if (Math.max(seriesScore[0].score, seriesScore[1].score) >= winsRequired) {
      throw new InconsistentProviderStateError('live match already has a series winner');
    }
    const liveMaps = maps.filter((entry) => entry.status === 'live');
    if (liveMaps.length > 1) {
      throw new InconsistentProviderStateError('multiple maps are live simultaneously');
    }
    if (
      maps.some(
        (entry) =>
          entry.status === 'closed-without-play' &&
          entry.technicalDisposition !== 'awarded',
      )
    ) {
      throw new InconsistentProviderStateError('live match contains an unused no-play map');
    }
    const liveMap = liveMaps[0];
    if (liveMap !== undefined) {
      if (
        maps.slice(0, liveMap.mapNumber - 1).some(
          (entry) =>
            !entry.settled ||
            (!entry.played && entry.technicalDisposition !== 'awarded'),
        ) ||
        maps.slice(liveMap.mapNumber).some((entry) => entry.status !== 'unopened')
      ) {
        throw new InconsistentProviderStateError('live map conflicts with chronological map order');
      }
      return {
        certainty: 'confirmed',
        closure: null,
        dataFinality: 'provisional',
        lifecycle: 'live',
        phase: { kind: 'map-live', mapNumber: liveMap.mapNumber },
      };
    }
    const settledMaps = maps.filter((entry) => entry.settled);
    const nextMap = maps.find((entry) => entry.status === 'unopened');
    if (settledMaps.length === 0 && nextMap !== undefined) {
      return {
        certainty: 'confirmed',
        closure: null,
        dataFinality: 'provisional',
        lifecycle: 'live',
        phase: { kind: 'map-unopened', mapNumber: nextMap.mapNumber },
      };
    }
    const previousMap = settledMaps.at(-1);
    if (previousMap !== undefined && nextMap !== undefined) {
      if (nextMap.mapNumber !== previousMap.mapNumber + 1) {
        throw new InconsistentProviderStateError('between-map order is not contiguous');
      }
      return {
        certainty: 'confirmed',
        closure: null,
        dataFinality: 'provisional',
        lifecycle: 'live',
        phase: {
          kind: 'between-maps',
          nextMapNumber: nextMap.mapNumber,
          previousMapNumber: previousMap.mapNumber,
        },
      };
    }
    throw new InconsistentProviderStateError('live match has no current or next map');
  }

  if (maps.some((entry) => entry.status === 'live')) {
    throw new InconsistentProviderStateError('terminal match still contains a live map');
  }
  if (Math.max(seriesScore[0].score, seriesScore[1].score) !== winsRequired) {
    throw new InconsistentProviderStateError('terminal series score has no winner');
  }
  const finalMap = [...maps]
    .reverse()
    .find((entry) => entry.played || entry.winnerTeamId !== null);
  if (finalMap === undefined) {
    throw new InconsistentProviderStateError('terminal match has no deciding map');
  }
  if (maps.slice(0, finalMap.mapNumber).some((entry) => entry.status === 'unopened')) {
    throw new InconsistentProviderStateError('terminal match has a gap in chronological map order');
  }
  const closure = maps.some((entry) => entry.technicalDisposition === 'awarded')
    ? 'administrative' as const
    : 'normal' as const;
  const normalShape =
    closure === 'normal' &&
    maps.slice(0, finalMap.mapNumber).every((entry) => entry.status === 'settled') &&
    maps.slice(finalMap.mapNumber).every(
      (entry) =>
        entry.status === 'unopened' ||
        (entry.status === 'closed-without-play' && entry.technicalDisposition === 'unused'),
    );
  const administrativeShape =
    closure === 'administrative' &&
    maps.slice(0, finalMap.mapNumber).every(
      (entry) =>
        (entry.status === 'settled' && entry.played) ||
        (entry.status === 'closed-without-play' && entry.technicalDisposition === 'awarded'),
    ) &&
    maps.slice(finalMap.mapNumber).every(
      (entry) =>
        entry.status === 'unopened' ||
        (entry.status === 'closed-without-play' && entry.technicalDisposition === 'unused'),
    );
  if (!normalShape && !administrativeShape) {
    throw new InconsistentProviderStateError('terminal map layout is not evidence-backed');
  }
  return {
    certainty: 'confirmed',
    closure,
    dataFinality: 'provisional',
    lifecycle: 'closing',
    phase: { finalMapNumber: finalMap.mapNumber, kind: 'series-ended' },
  };
}

function vetoEntries(value: unknown, teamIds: readonly [string, string]): readonly VetoEntry[] {
  return asArray(value, 'global_state.bp_map_item').map((entry) => {
    const veto = asRecord(entry, 'veto entry');
    const action = nullableString(veto.bp_type);
    const side = nullableString(veto.team_side);
    return {
      action:
        action === 'ban' || action === 'pick' || action === 'left' ? action : 'unknown',
      mapIconUrl: nullableString(veto.map_icon),
      mapLogoUrl: nullableString(veto.map_logo),
      mapName: nullableString(veto.map_name),
      teamId: side === 't1' ? teamIds[0] : side === 't2' ? teamIds[1] : null,
    };
  });
}

function tournament(value: unknown): Tournament {
  const info = asRecord(value, 'match.tt_info');
  return {
    id: asString(info.id, 'match.tt_info.id'),
    gradeCode: nullableString(info.grade),
    gradeLabel: nullableString(info.grade_label),
    location: nullableString(info.addr),
    logoUrl: nullableString(info.logo),
    name: asString(info.disp_name, 'match.tt_info.disp_name'),
    prize: nullableString(info.bonus),
    providerLocalEndTime: nullableString(info.end_time),
    providerLocalStartTime: nullableString(info.start_time),
    stage: null,
    stageDescription: null,
    status: nullableString(info.status),
  };
}

function canonicalMapName(value: string): string {
  return value.trim().toLowerCase().replace(/^de_/, '').replace(/[^a-z0-9]/g, '');
}

function selectedMapOrder(value: unknown): readonly string[] | null {
  try {
    const selected = asArray(value, 'global_state.bp_map_item').flatMap((entry) => {
      const item = asRecord(entry, 'global_state.bp_map_item entry');
      const action = nullableString(item.bp_type);
      const name = nullableString(item.map_name);
      return (action === 'pick' || action === 'left') && name !== null
        ? [canonicalMapName(name)]
        : [];
    });
    return selected.length === 3 && new Set(selected).size === 3 ? selected : null;
  } catch {
    return null;
  }
}

export function decodeCoreResponse(
  payload: unknown,
  requestedMatchId: string,
  observedAt = unixMilliseconds(),
): DecodedCore {
  const envelope = asRecord(payload, 'response');
  if (envelope.success === false) {
    throw new ProviderUnavailableError('provider response reported an operational failure');
  }
  if (envelope.success !== true) throw new TypeError('provider response success flag is invalid');
  const data = asRecord(envelope.data, 'response.data');
  const providerMatch = asRecord(data.match, 'response.data.match');
  const matchInfo = asRecord(providerMatch.mc_info, 'match.mc_info');
  const matchId = asString(matchInfo.id, 'match.mc_info.id');
  if (matchId !== requestedMatchId) {
    throw new InconsistentProviderStateError('match identity mismatch');
  }

  const providerBouts = asArray(providerMatch.bouts_state, 'match.bouts_state');
  const providerFormat = nullableString(matchInfo.format);
  const participantsUnresolved = [matchInfo.t1_info, matchInfo.t2_info].some((info) => {
    try {
      return nullableString(asRecord(info, 'match team info').id) === null;
    } catch {
      return true;
    }
  });
  if (
    (providerFormat === null || providerFormat === '3') &&
    providerBouts.length === 3 &&
    participantsUnresolved
  ) {
    throw new UnsupportedFormatError('3', 'participants-unresolved');
  }
  if (providerFormat === '1') {
    throw new UnsupportedFormatError(providerFormat, 'format-unverified');
  }
  if (providerFormat !== '3') {
    throw new UnsupportedFormatError(providerFormat ?? '', 'format-not-supported');
  }
  if (asString(matchInfo.match_version, 'match.mc_info.match_version') !== 'cs2') {
    throw new TypeError('provider match is not CS2');
  }

  const firstTeam = team(matchInfo.t1_info, 'match.mc_info.t1_info');
  const secondTeam = team(matchInfo.t2_info, 'match.mc_info.t2_info');
  const teamIds = [firstTeam.id, secondTeam.id] as const;
  const globalState = asRecord(providerMatch.global_state, 'match.global_state');
  const globalStatus = integer(globalState.status, 'match.global_state.status');
  if (globalStatus !== 0 && globalStatus !== 1 && globalStatus !== 2) {
    throw new InconsistentProviderStateError(`unsupported global status ${globalStatus}`);
  }
  if (providerBouts.length !== 3) throw new TypeError('BO3 must contain three map slots');
  const boutEvidence = providerBouts
    .map((bout, index) => ({
      bout,
      providerBoutNumber: integer(
        asRecord(bout, `match.bouts_state[${index}]`).bout_num,
        `match.bouts_state[${index}].bout_num`,
      ),
      result: nullableString(
        asRecord(bout, `match.bouts_state[${index}]`).result,
      ),
      mapName: nullableString(
        asRecord(bout, `match.bouts_state[${index}]`).map_name,
      ),
      startedAt: providerSeconds(
        asRecord(bout, `match.bouts_state[${index}]`).start_time,
        `match.bouts_state[${index}].start_time`,
      ),
      statusCode: integer(
        asRecord(bout, `match.bouts_state[${index}]`).status,
        `match.bouts_state[${index}].status`,
      ),
    }));
  if (
    boutEvidence.some(
      (entry) => entry.statusCode !== -1 && entry.statusCode !== 1 && entry.statusCode !== 2,
    )
  ) {
    throw new InconsistentProviderStateError('provider bout has an unsupported status');
  }
  const providerOrderedBouts = [...boutEvidence].sort(
    (first, second) => first.providerBoutNumber - second.providerBoutNumber,
  );
  if (
    providerOrderedBouts.some(
      (entry, index) => entry.providerBoutNumber !== index + 1,
    )
  ) {
    throw new InconsistentProviderStateError('BO3 map slots are duplicated or missing');
  }
  const progressRank = (entry: (typeof boutEvidence)[number]): number => {
    if (entry.statusCode === 2 && entry.startedAt !== null) return 0;
    if (
      entry.statusCode === 2 ||
      (entry.statusCode === -1 && (entry.result === 't1' || entry.result === 't2'))
    ) {
      return 1;
    }
    if (entry.statusCode === 1) return 2;
    return 3;
  };
  const bpMapOrder = selectedMapOrder(globalState.bp_map_item);
  const bpIndexes = bpMapOrder === null
    ? null
    : new Map(bpMapOrder.map((name, index) => [name, index]));
  const bpOrderIsComplete =
    bpIndexes !== null &&
    boutEvidence.every(
      (entry) => entry.mapName !== null && bpIndexes.has(canonicalMapName(entry.mapName)),
    ) &&
    new Set(boutEvidence.map((entry) => canonicalMapName(entry.mapName ?? ''))).size === 3;
  const chronologicalBouts = [...boutEvidence].sort((first, second) => {
    if (bpOrderIsComplete && bpIndexes !== null) {
      return (
        (bpIndexes.get(canonicalMapName(first.mapName ?? '')) ?? 0) -
        (bpIndexes.get(canonicalMapName(second.mapName ?? '')) ?? 0)
      );
    }
    const rankDifference = progressRank(first) - progressRank(second);
    if (rankDifference !== 0) return rankDifference;
    if (first.startedAt !== null && second.startedAt !== null) {
      const timeDifference = first.startedAt - second.startedAt;
      if (timeDifference !== 0) return timeDifference;
    }
    return first.providerBoutNumber - second.providerBoutNumber;
  });
  const liveEntries = chronologicalBouts
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.statusCode === 1);
  let credibleLiveProviderBoutNumber: number | null = null;
  if (liveEntries.length > 1) {
    for (const { entry, index } of liveEntries) {
      try {
        map(
          entry.bout,
          (index + 1) as MapNumber,
          entry.providerBoutNumber,
          'confirmed',
          teamIds,
        );
        credibleLiveProviderBoutNumber = entry.providerBoutNumber;
        break;
      } catch {
        // Try the next live-marked slot. A provider transition can briefly leave
        // a later slot carrying impossible scores from another lifecycle.
      }
    }
  }
  const decodedMaps = chronologicalBouts.map((entry, index) =>
    map(
      entry.bout,
      (index + 1) as MapNumber,
      entry.providerBoutNumber,
      entry.statusCode === 1 ||
        entry.startedAt !== null ||
        (
          (entry.statusCode === 2 || entry.statusCode === -1) &&
          (entry.result === 't1' || entry.result === 't2')
        )
        ? 'confirmed'
        : 'provisional',
      teamIds,
      liveEntries.length > 1 &&
        credibleLiveProviderBoutNumber !== null &&
        entry.statusCode === 1 &&
        entry.providerBoutNumber !== credibleLiveProviderBoutNumber,
    ),
  );
  const providerSeriesScore = [
    { score: integer(globalState.t1_score, 'global_state.t1_score'), teamId: firstTeam.id },
    { score: integer(globalState.t2_score, 'global_state.t2_score'), teamId: secondTeam.id },
  ] as const satisfies readonly [TeamScore, TeamScore];
  const maps = reconcileTerminalNoPlayAward(globalStatus, decodedMaps, providerSeriesScore);
  const settledWinnerCounts = teamIds.map(
    (teamId) => maps.filter((entry) => entry.winnerTeamId === teamId).length,
  ) as [number, number];
  const mapsProveTerminal =
    globalStatus === 1 &&
    maps.every((entry) => entry.status !== 'live') &&
    Math.max(...settledWinnerCounts) >= 2;
  const seriesScore = mapsProveTerminal
    ? [
        { score: settledWinnerCounts[0], teamId: firstTeam.id },
        { score: settledWinnerCounts[1], teamId: secondTeam.id },
      ] as const satisfies readonly [TeamScore, TeamScore]
    : providerSeriesScore;
  const state = stateFromEvidence(mapsProveTerminal ? 2 : globalStatus, maps, seriesScore, 2);
  const stateVersion = asString(data.state_ver, 'response.data.state_ver');
  const confirmedSeriesPlayerStatistics = seriesPlayerStatistics(globalState, teamIds);
  const snapshot: ConfirmedMatchObservation = {
    freshness: {
      coreObservedAt: observedAt,
      localVersion: nullableNumber(data.local_ver) ?? 0,
      stateVersion,
    },
    maps,
    match: {
      format: 'bo3',
      gameVersion: 'cs2',
      id: matchId,
      scheduledAt: secondsToMilliseconds(matchInfo.plan_ts),
    },
    observedAt,
    providerState: {
      bouts: providerOrderedBouts.map((entry) => ({
        providerBoutNumber: entry.providerBoutNumber,
        statusCode: entry.statusCode as -1 | 1 | 2,
      })),
      globalStatusCode: globalStatus,
    },
    revision: '' as MatchSnapshot['revision'],
    schema: 'fiveeplay-match/v3',
    seriesPlayerStatistics: confirmedSeriesPlayerStatistics,
    seriesScore,
    seriesWinnerTeamId:
      state.lifecycle === 'closing'
        ? seriesScore.find((entry) => entry.score === 2)?.teamId ?? null
        : null,
    state,
    teams: [firstTeam, secondTeam],
    tournament: {
      ...tournament(providerMatch.tt_info),
      stage: nullableString(matchInfo.tt_stage),
      stageDescription: nullableString(matchInfo.tt_stage_desc),
    },
    veto: vetoEntries(globalState.bp_map_item, teamIds),
  };

  return deepFreeze({
    snapshot: { ...snapshot, revision: revisionFor(snapshot) },
  });
}
