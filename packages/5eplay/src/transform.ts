import { mergeLogEvents, transformLogRecord } from './log.js';
import { matchIdentityFromInput } from './input.js';
import type {
  FiveEPlayAnalysisMap,
  FiveEPlayAnalysisPlayer,
  FiveEPlayCommunityCard,
  FiveEPlayCommunityRatings,
  FiveEPlayHalfScore,
  FiveEPlayMap,
  FiveEPlayMapStatus,
  FiveEPlayMatch,
  FiveEPlayMatchIdentity,
  FiveEPlayMatchStatus,
  FiveEPlayPlayerStats,
  FiveEPlayPrematchAnalysis,
  FiveEPlayRecentMatchReference,
  FiveEPlayTeam,
  FiveEPlayTeamMapState,
  FiveEPlayVetoEntry,
} from './types.js';
import {
  flag,
  integer,
  jsonObjects,
  numeric,
  record,
  records,
  side,
  strings,
  text,
} from './value.js';

export interface LogCapture {
  complete: boolean;
  fromVersion: string | null;
  toVersion: string | null;
  rows: unknown[];
}

export interface CommunityCapture {
  tabs: unknown[];
  cardsByTab: Map<string, unknown[]>;
}

export interface BuildMatchInput {
  identity: FiveEPlayMatchIdentity;
  capturedAt: string;
  detailData: unknown;
  analysisData: unknown | null;
  logs: Map<number, LogCapture>;
  community: CommunityCapture | null;
}

function cleanName(value: unknown): string {
  return text(value) ?? '';
}

function teamFromSource(
  source: Record<string, unknown>,
  series: Record<string, unknown>,
  sideKey: 't1' | 't2',
): FiveEPlayTeam {
  const rank = record(source.v_rank);
  return {
    id: text(source.id) ?? sideKey,
    name: cleanName(source.disp_name),
    logoUrl: text(source.logo),
    country: text(source.country),
    rank: integer(source.rank),
    valveRank: integer(rank.rank),
    seriesScore: integer(series[`${sideKey}_score`]),
    quickScore: integer(series[`${sideKey}_quick_score`]),
    odds: numeric(series[`${sideKey}_odds`]),
    oddsPercent: numeric(series[`${sideKey}_odds_percent`]),
  };
}

function vetoAction(value: unknown): FiveEPlayVetoEntry['action'] {
  const normalized = text(value);
  if (normalized === 'ban' || normalized === 'pick' || normalized === 'left') return normalized;
  return 'unknown';
}

function vetoEntries(
  value: unknown,
  teams: FiveEPlayTeam[],
): FiveEPlayVetoEntry[] {
  return records(value).map((entry, index) => {
    const teamSide = text(entry.team_side);
    return {
      order: index + 1,
      action: vetoAction(entry.bp_type),
      teamId: teamSide === 't1' ? teams[0]?.id ?? null
        : teamSide === 't2' ? teams[1]?.id ?? null : null,
      map: cleanName(entry.map_name),
      iconUrl: text(entry.map_icon),
      backgroundUrl: text(entry.map_logo),
    };
  });
}

function mapStatus(value: unknown): FiveEPlayMapStatus {
  if (value === 2 || value === '2') return 'completed';
  if (value === 1 || value === '1') return 'live';
  if (value === -1 || value === '-1' || value === 0 || value === '0') return 'upcoming';
  return 'unknown';
}

function half(
  source: Record<string, unknown>,
  prefix: 'fh' | 'sh' | 'ot',
): FiveEPlayHalfScore {
  const rawResults = source[`${prefix}_data`];
  return {
    side: side(source[`${prefix}_role`]),
    score: integer(source[`${prefix}_score`]),
    roundResults: Array.isArray(rawResults)
      ? rawResults.flatMap((item: unknown) => {
        const result = integer(item);
        return result === null ? [] : [result];
      })
      : [],
  };
}

function mapTeamState(value: unknown, fallbackTeamId: string | null): FiveEPlayTeamMapState {
  const source = record(value);
  return {
    teamId: text(source.id) ?? fallbackTeamId,
    currentSide: side(source.role),
    score: integer(source.all_score),
    quickScore: integer(source.quick_score),
    firstHalf: half(source, 'fh'),
    secondHalf: half(source, 'sh'),
    overtime: half(source, 'ot'),
    flags: strings(source.flags),
  };
}

function countMap(value: unknown): Record<string, number> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([key, raw]) => {
    const parsed = integer(raw);
    return parsed === null ? [] : [[key, parsed]];
  }));
}

function playerStats(value: unknown): FiveEPlayPlayerStats {
  const source = record(value);
  const hp = integer(source.hp);
  return {
    id: text(source.id) ?? '',
    name: cleanName(source.name),
    countryLogoUrl: text(source.country_logo),
    portraitUrl: text(source.portrait),
    halfPortraitUrl: text(source.half_portrait),
    equipment: {
      health: hp,
      money: integer(source.money),
      armor: flag(source.kevlar),
      helmet: flag(source.helmet),
      defuseKit: flag(source.has_defusekit),
      alive: hp === null ? null : hp > 0,
      weapon: text(source.weapon),
      weaponLogoUrl: text(source.weapon_logo),
    },
    metrics: {
      kills: integer(source.kill),
      deaths: integer(source.death),
      assists: integer(source.assist),
      kdRatio: numeric(source.kd_rate),
      kdDifference: integer(source.kd_diff),
      rating: numeric(source.rating),
      kastRate: numeric(source.kast),
      adr: numeric(source.adr),
      killsPerRound: numeric(source.kpr),
      deathsPerRound: numeric(source.dpr),
      impact: numeric(source.impact),
      multiKillRating: numeric(source.mk_rating),
      roundSwingRate: numeric(source.swing),
      headshots: integer(source.headshot),
      headshotRate: numeric(source.head_shot_rate),
      firstKills: integer(source.first_blood_num),
      firstDeaths: integer(source.first_death_num),
      firstKillRate: numeric(source.first_blood_rate),
      flashAssists: integer(source.flash_assist),
      tradedDeaths: integer(source.traded_death),
      clutchWins: integer(source.cl_win_num),
      roundMvp: integer(source.round_mvp),
      multiKills: {
        two: integer(source.k2), three: integer(source.k3),
        four: integer(source.k4), five: integer(source.k5),
      },
      clutches: {
        oneVsOne: integer(source.v1), oneVsTwo: integer(source.v2),
        oneVsThree: integer(source.v3), oneVsFour: integer(source.v4),
        oneVsFive: integer(source.v5),
      },
    },
    versusKills: countMap(source.counter_kill_map),
    firstKillsByOpponent: countMap(source.first_kill_map),
  };
}

function players(value: unknown): FiveEPlayPlayerStats[] {
  return records(value).map(playerStats).filter((item) => item.id || item.name);
}

function mapPlayerStats(
  source: Record<string, unknown>,
  teams: FiveEPlayTeam[],
): FiveEPlayMap['playerStats'] {
  return teams.map((team, index) => {
    const key = index === 0 ? 't1' : 't2';
    return {
      teamId: team.id,
      overall: players(source[`${key}_pr_stats`]),
      ct: players(source[`${key}_pr_stats_ct`]),
      t: players(source[`${key}_pr_stats_t`]),
    };
  });
}

function mapDuels(stats: FiveEPlayMap['playerStats']): FiveEPlayMap['playerDuels'] {
  return stats.flatMap((team) => team.overall.flatMap((player) =>
    Object.entries(player.versusKills).map(([opponentPlayerId, kills]) => ({
      playerId: player.id,
      opponentPlayerId,
      kills,
    }))));
}

function pickTeamId(value: unknown, teams: FiveEPlayTeam[]): string | null {
  const normalized = text(value);
  if (normalized?.startsWith('t1_')) return teams[0]?.id ?? null;
  if (normalized?.startsWith('t2_')) return teams[1]?.id ?? null;
  return null;
}

function mapFromSource(
  value: unknown,
  identity: FiveEPlayMatchIdentity,
  teams: FiveEPlayTeam[],
  logs: Map<number, LogCapture>,
): FiveEPlayMap {
  const source = record(value);
  const number = integer(source.bout_num) ?? 0;
  const stats = mapPlayerStats(source, teams);
  const capture = logs.get(number);
  const transformedLogs = capture?.rows.map(transformLogRecord) ?? [];
  const action = text(source.bp_act);
  return {
    id: `${identity.id}_${number}`,
    number,
    label: text(source.disp_name) ?? `Map ${number}`,
    name: cleanName(source.map_name),
    status: mapStatus(source.status),
    display: source.display !== '2' && source.display !== 2,
    pickedByTeamId: pickTeamId(source.bp_act, teams),
    pickAction: action === 'left' ? 'left' : action?.endsWith('_pick') ? 'pick' : 'unknown',
    resultTeamId: source.result === 't1' ? teams[0]?.id ?? null
      : source.result === 't2' ? teams[1]?.id ?? null : null,
    iconUrl: text(source.map_icon),
    backgroundUrl: text(source.map_bgm),
    startedAtUnixSeconds: integer(source.start_time),
    endedAtUnixSeconds: integer(source.end_time),
    currentRound: integer(source.curr_round_num),
    roundStage: text(source.curr_bout_stage),
    gameTimeSeconds: integer(source.game_time),
    roundStartedAtUnixSeconds: integer(source.round_start_time),
    bombPlanted: flag(source.bomb_planted) === true,
    bombPlantedAtUnixSeconds: integer(source.bomb_planted_time),
    teams: [
      mapTeamState(source.t1_stats, teams[0]?.id ?? null),
      mapTeamState(source.t2_stats, teams[1]?.id ?? null),
    ],
    playerStats: stats,
    playerDuels: mapDuels(stats),
    highlights: jsonObjects(source.pr_stats),
    milestones: jsonObjects(source.milestones),
    eventLog: {
      order: 'chronological',
      complete: capture?.complete ?? false,
      fromVersion: capture?.fromVersion ?? null,
      toVersion: capture?.toVersion ?? null,
      events: mergeLogEvents([], transformedLogs),
    },
  };
}

function upcomingMap(
  entry: FiveEPlayVetoEntry,
  number: number,
  identity: FiveEPlayMatchIdentity,
  teams: FiveEPlayTeam[],
): Record<string, unknown> {
  return {
    bout_num: String(number),
    disp_name: `第${number}局`,
    map_name: entry.map,
    map_icon: entry.iconUrl ?? '',
    map_bgm: entry.backgroundUrl ?? '',
    bp_act: entry.action === 'left' ? 'left' : entry.teamId ? 'pick' : '',
    status: '-1',
    display: '1',
    t1_stats: { id: teams[0]?.id ?? null },
    t2_stats: { id: teams[1]?.id ?? null },
    match_id: identity.id,
  };
}

function allMaps(
  sourceBouts: unknown,
  veto: FiveEPlayVetoEntry[],
  identity: FiveEPlayMatchIdentity,
  teams: FiveEPlayTeam[],
  logs: Map<number, LogCapture>,
): FiveEPlayMap[] {
  const bouts = records(sourceBouts);
  const seriesMaps = veto.filter((entry) => entry.action === 'pick' || entry.action === 'left');
  for (const [index, entry] of seriesMaps.entries()) {
    if (!bouts.some((bout) => text(bout.map_name) === entry.map)) {
      const synthesized = upcomingMap(entry, index + 1, identity, teams);
      if (entry.action === 'pick') {
        synthesized.bp_act = entry.teamId === teams[0]?.id ? 't1_pick' : 't2_pick';
      }
      bouts.push(synthesized);
    }
  }
  return bouts
    .map((bout) => mapFromSource(bout, identity, teams, logs))
    .filter((map) => map.number > 0 && map.name)
    .sort((left, right) => left.number - right.number);
}

function matchStatus(global: Record<string, unknown>, maps: FiveEPlayMap[]): FiveEPlayMatchStatus {
  if (maps.some((map) => map.status === 'live') || global.status === '1' || global.status === 1) return 'live';
  if (global.status === '-1' || global.status === -1) return 'upcoming';
  if (global.status === '2' || global.status === 2) return 'completed';
  const meaningful = maps.filter((map) => map.status !== 'unknown');
  if (meaningful.length && meaningful.every((map) => map.status === 'completed')) return 'completed';
  if (meaningful.some((map) => map.status === 'upcoming')) return 'upcoming';
  return 'unknown';
}

function analysisPlayer(value: unknown): FiveEPlayAnalysisPlayer {
  const source = record(value);
  return {
    id: text(source.id) ?? '',
    name: cleanName(source.name),
    country: text(source.country_name),
    countryLogoUrl: text(source.country_logo),
    logoUrl: text(source.logo),
    halfPortraitUrl: text(source.half_logo),
    rating: numeric(source.Rating),
    kdRatio: numeric(source.kd),
    kastRate: numeric(source.kast),
    adr: numeric(source.adr),
    killsPerRound: numeric(source.kpr),
    impact: numeric(source.impact),
    multiKillRating: numeric(source.mk_rating),
    roundSwingRate: numeric(source.swing),
  };
}

function analysisMap(
  value: unknown,
  teams: FiveEPlayTeam[],
): FiveEPlayAnalysisMap {
  const source = record(value);
  return {
    id: text(source.id),
    name: cleanName(source.name),
    localizedName: text(source.name_zh),
    iconUrl: text(source.icon),
    backgroundUrl: text(source.bgm),
    bpType: text(source.bp_type),
    teams: teams.map((team, index) => {
      const key = index === 0 ? 't1' : 't2';
      return {
        teamId: team.id,
        matches: integer(source[`${key}_count`]),
        wins: integer(source[`${key}_win_num`]),
        winRate: numeric(source[`${key}_rate`]),
        picks: integer(source[`${key}_pick_count`]),
        pickRate: numeric(source[`${key}_pick_rate`]),
        bans: integer(source[`${key}_ban_count`]),
        banRate: numeric(source[`${key}_ban_rate`]),
      };
    }),
  };
}

function recentMatchRows(value: unknown): Record<string, unknown>[] {
  return records(record(value).matches).flatMap((group) => {
    const nested = records(group.matches);
    return nested.length ? nested : text(group.id) ? [group] : [];
  });
}

function completedRecentMatch(value: unknown): FiveEPlayRecentMatchReference | null {
  const source = record(value);
  const identity = matchIdentityFromInput(text(source.id) ?? '');
  const status = text(source.status)?.toLowerCase();
  const playedAtUnixSeconds = integer(source.ts);
  const first = record(source.home_info);
  const second = record(source.opponent_info);
  const firstId = text(first.id);
  const secondId = text(second.id);
  const firstName = text(first.disp_name);
  const secondName = text(second.disp_name);
  const firstScore = integer(source.home_score);
  const secondScore = integer(source.opponent_score);
  const completed = status === 'past' || status === 'completed' || status === '2';
  if (!identity || !completed || playedAtUnixSeconds === null || playedAtUnixSeconds <= 0
    || !firstId || !secondId || !firstName || !secondName
    || firstScore === null || secondScore === null || firstScore < 0 || secondScore < 0) {
    return null;
  }
  return {
    ...identity,
    status: 'completed',
    playedAtUnixSeconds,
    teams: [
      { id: firstId, name: firstName, score: firstScore },
      { id: secondId, name: secondName, score: secondScore },
    ],
    winnerTeamId: firstScore === secondScore ? null : firstScore > secondScore ? firstId : secondId,
  };
}

function recentMatches(value: unknown): {
  sourceCount: number;
  invalidReferenceCount: number;
  matches: FiveEPlayRecentMatchReference[];
} {
  const rows = recentMatchRows(value);
  const normalized = rows.map(completedRecentMatch);
  const byId = new Map(normalized.flatMap((match) => match ? [[match.id, match] as const] : []));
  return {
    sourceCount: rows.length,
    invalidReferenceCount: normalized.filter((match) => match === null).length,
    matches: [...byId.values()].sort(
      (left, right) => right.playedAtUnixSeconds - left.playedAtUnixSeconds,
    ),
  };
}

function prematchAnalysis(value: unknown, teams: FiveEPlayTeam[]): FiveEPlayPrematchAnalysis | null {
  if (value === null) return null;
  const data = record(value);
  const result = record(data.result);
  const comparison = record(result.comparison);
  if (!Object.keys(result).length) return null;
  const power = record(result.power_comparison);
  const teamAnalysis = teams.map((team, index) => {
    const key = index === 0 ? 't1' : 't2';
    const metrics = record(comparison[`${key}_stats`]);
    return {
      teamId: team.id,
      winRate: numeric(metrics.win_rate),
      rating: numeric(metrics.rating),
      kdRatio: numeric(metrics.kd),
      firstHalfPistolWinRate: numeric(metrics.f_rate),
      secondHalfPistolWinRate: numeric(metrics.s_rate),
      players: records(comparison[`${key}_player_stats`]).map(analysisPlayer),
    };
  });
  return {
    hidden: flag(power.is_hide) === true,
    teams: teamAnalysis,
    maps: records(comparison.team_map_stats).map((map) => analysisMap(map, teams)),
    playerPower: teams.map((team, index) => ({
      teamId: team.id,
      players: jsonObjects(power[index === 0 ? 't1_player_stats' : 't2_player_stats']),
    })),
    recentMatches: teams.map((team, index) => ({
      teamId: team.id,
      ...recentMatches(result[index === 0 ? 't1_rec_matches' : 't2_rec_matches']),
    })),
    headToHead: {
      teamWinRates: teams.map((team, index) => ({
        teamId: team.id,
        winRate: numeric(record(result.rec_vs_matches)[index === 0 ? 't1_win_rate' : 't2_win_rate']),
      })),
      matches: jsonObjects(record(result.rec_vs_matches).matches),
    },
  };
}

function communityCard(value: unknown): FiveEPlayCommunityCard {
  const source = record(value);
  const score = record(source.score);
  return {
    tab: text(source.tab) ?? '',
    contentType: text(source.card_content_tab),
    id: text(source.id) ?? '',
    name: cleanName(source.name),
    logoUrl: text(source.logo),
    teamLogoUrl: text(source.team_logo),
    countryLogoUrl: text(source.country_logo),
    detail: text(source.detail),
    positions: strings(source.positions),
    content: strings(source.content),
    score: {
      average: numeric(score.avg_score),
      userCount: integer(score.user_cnt) ?? 0,
      text: text(score.score_text),
      starCounts: Array.isArray(score.star_num_user_cnt)
        ? score.star_num_user_cnt.flatMap((item) => integer(item) ?? []) : [],
      starPercentages: Array.isArray(score.star_num_user_pct)
        ? score.star_num_user_pct.map(numeric) : [],
    },
    starLabels: strings(source.star_text),
  };
}

function communityRatings(capture: CommunityCapture | null): FiveEPlayCommunityRatings | null {
  if (!capture) return null;
  return {
    tabs: capture.tabs.map((value) => {
      const tab = record(value);
      const tabName = text(tab.tab) ?? '';
      const id = text(tab.id) ?? '';
      return {
        tab: tabName,
        id,
        name: cleanName(tab.name),
        logoUrl: text(tab.logo),
        selected: flag(tab.is_selected) === true,
        cards: (capture.cardsByTab.get(`${tabName}:${id}`) ?? []).map(communityCard),
      };
    }),
  };
}

export function buildFiveEPlayMatch(input: BuildMatchInput): FiveEPlayMatch {
  const detail = record(input.detailData);
  const sourceMatch = record(detail.match);
  const global = record(sourceMatch.global_state);
  const matchInfo = record(sourceMatch.mc_info);
  const tournamentInfo = record(sourceMatch.tt_info);
  const teams = [
    teamFromSource(record(matchInfo.t1_info), global, 't1'),
    teamFromSource(record(matchInfo.t2_info), global, 't2'),
  ];
  const veto = vetoEntries(global.bp_map_item, teams);
  const maps = allMaps(sourceMatch.bouts_state, veto, input.identity, teams, input.logs);
  const current = maps.find((map) => map.status === 'live') ?? null;
  return {
    schemaVersion: '1.0.0',
    capturedAt: input.capturedAt,
    sport: 'cs2',
    source: { provider: '5eplay', url: input.identity.url },
    stateVersion: text(detail.state_ver),
    match: {
      id: input.identity.id,
      numericId: input.identity.numericId,
      status: matchStatus(global, maps),
      version: text(matchInfo.match_version),
      bestOf: integer(matchInfo.format),
      scheduledAtUnixSeconds: integer(matchInfo.plan_ts),
      stage: text(matchInfo.tt_stage),
      stageDescription: text(matchInfo.tt_stage_desc),
      seriesScore: teams.map((team) => ({ teamId: team.id, score: team.seriesScore })),
    },
    tournament: {
      id: text(tournamentInfo.id),
      name: cleanName(tournamentInfo.disp_name),
      logoUrl: text(tournamentInfo.logo),
      status: text(tournamentInfo.status),
      grade: text(tournamentInfo.grade),
      gradeLabel: text(tournamentInfo.grade_label),
      location: text(tournamentInfo.addr) ?? text(tournamentInfo.city_name),
      prize: text(tournamentInfo.bonus),
      startsAt: text(tournamentInfo.start_time),
      endsAt: text(tournamentInfo.end_time),
      color: text(tournamentInfo.color),
    },
    teams,
    veto,
    maps,
    current,
    analysis: prematchAnalysis(input.analysisData, teams),
    communityRatings: communityRatings(input.community),
  };
}

export function mergeDetailData(base: unknown, update: unknown): unknown {
  const baseData = record(base);
  const updateData = record(update);
  const baseMatch = record(baseData.match);
  const updateMatch = record(updateData.match);
  const mergedBouts = records(baseMatch.bouts_state);
  for (const bout of records(updateMatch.bouts_state)) {
    const number = integer(bout.bout_num);
    const index = mergedBouts.findIndex((candidate) => integer(candidate.bout_num) === number);
    if (index >= 0) mergedBouts[index] = { ...mergedBouts[index], ...bout };
    else mergedBouts.push(bout);
  }
  return {
    ...baseData,
    ...updateData,
    match: {
      ...baseMatch,
      ...updateMatch,
      global_state: { ...record(baseMatch.global_state), ...record(updateMatch.global_state) },
      mc_info: { ...record(baseMatch.mc_info), ...record(updateMatch.mc_info) },
      tt_info: { ...record(baseMatch.tt_info), ...record(updateMatch.tt_info) },
      bouts_state: mergedBouts,
    },
  };
}
