import type {
  AnalysisMap,
  AnalysisMapTeam,
  AnalysisPlayer,
  AnalysisTeam,
  HistoricalMatch,
  MatchAnalysis,
  PlayerPower,
  PlayerPowerMetric,
} from '../domain/model.js';
import {
  asArray,
  asRecord,
  asString,
  nullableNumber,
  nullableString,
} from '../internal/value.js';
import {
  arrayOrEmpty,
  historicalMatch,
  historicalTournament,
  percentNumber,
  providerData,
} from './shared.js';

function analysisPlayer(value: unknown, label: string): AnalysisPlayer {
  const player = asRecord(value, label);
  return {
    adr: nullableNumber(player.adr),
    country: nullableString(player.country_name),
    countryLogoUrl: nullableString(player.country_logo),
    id: asString(player.id, `${label}.id`),
    impact: nullableNumber(player.impact),
    kastPercent: percentNumber(player.kast),
    killDeathRatio: nullableNumber(player.kd),
    killsPerRound: nullableNumber(player.kpr),
    multiKillRating: nullableNumber(player.mk_rating),
    name: asString(player.name, `${label}.name`),
    portraitUrl: nullableString(player.logo),
    rating: nullableNumber(player.Rating),
    swing: nullableNumber(
      typeof player.swing === 'string' ? player.swing.replace('%', '') : player.swing,
    ),
  };
}

function analysisTeam(
  teamId: string,
  statsValue: unknown,
  playersValue: unknown,
  label: string,
): AnalysisTeam {
  const stats = asRecord(statsValue, `${label}.stats`);
  return {
    firstSideRate: percentNumber(stats.f_rate),
    killDeathRatio: nullableNumber(stats.kd),
    players: asArray(playersValue, `${label}.players`).map((player, index) =>
      analysisPlayer(player, `${label}.players[${index}]`),
    ),
    rating: nullableNumber(stats.rating),
    secondSideRate: percentNumber(stats.s_rate),
    teamId,
    winRate: percentNumber(stats.win_rate),
  };
}

function mapTeam(
  value: Record<string, unknown>,
  prefix: 't1' | 't2',
  teamId: string,
): AnalysisMapTeam {
  return {
    banRate: percentNumber(value[`${prefix}_ban_rate`]),
    bans: nullableNumber(value[`${prefix}_ban_count`]),
    matches: nullableNumber(value[`${prefix}_win_num`]),
    pickRate: percentNumber(value[`${prefix}_pick_rate`]),
    picks: nullableNumber(value[`${prefix}_pick_count`]),
    teamId,
    winRate: percentNumber(value[`${prefix}_rate`]),
    wins: null,
  };
}

function analysisMap(
  value: unknown,
  teamIds: readonly [string, string],
  label: string,
): AnalysisMap {
  const map = asRecord(value, label);
  const providerVeto = nullableString(map.bp_type);
  const vetoAction =
    providerVeto === 'left'
      ? 'left'
      : providerVeto === 't1_pick' || providerVeto === 't2_pick'
        ? 'pick'
        : providerVeto === 't1_ban' || providerVeto === 't2_ban'
          ? 'ban'
          : 'unknown';
  const vetoTeamId =
    providerVeto === 't1_pick' || providerVeto === 't1_ban'
      ? teamIds[0]
      : providerVeto === 't2_pick' || providerVeto === 't2_ban'
        ? teamIds[1]
        : null;
  return {
    backgroundUrl: nullableString(map.bgm),
    iconUrl: nullableString(map.icon),
    id: nullableString(map.id),
    localizedName: nullableString(map.name_zh),
    name: asString(map.name, `${label}.name`),
    teams: [mapTeam(map, 't1', teamIds[0]), mapTeam(map, 't2', teamIds[1])],
    vetoAction,
    vetoTeamId,
  };
}

function powerMetric(value: unknown, label: string): PlayerPowerMetric {
  const metric = asRecord(value, label);
  return {
    children: arrayOrEmpty(metric.power_items, `${label}.power_items`).map((child, index) =>
      powerMetric(child, `${label}.power_items[${index}]`),
    ),
    guideline: nullableString(metric.score_guideline),
    iconUrl: nullableString(metric.label_icon),
    key: asString(metric.label_key, `${label}.label_key`),
    name: asString(metric.label_name, `${label}.label_name`),
    score: nullableString(metric.score),
    width: nullableNumber(metric.width),
  };
}

function playerPower(value: unknown, label: string): PlayerPower {
  const power = asRecord(value, label);
  const player = asRecord(power.player_item, `${label}.player_item`);
  return {
    country: nullableString(player.country_name),
    countryLogoUrl: nullableString(player.country_logo),
    hltvRating: nullableNumber(player.hltv_rating),
    hidden: power.is_hide === '1' || power.is_hide === 1 || power.is_hide === true,
    metrics: arrayOrEmpty(power.player_power_data_items, `${label}.metrics`).map(
      (metric, index) => powerMetric(metric, `${label}.metrics[${index}]`),
    ),
    playerId: asString(player.player_id, `${label}.player_id`),
    playerName: asString(player.player_name, `${label}.player_name`),
    portraitUrl: nullableString(player.player_half_portrait),
    side: nullableString(player.side),
    sideLabel: nullableString(player.side_label_name),
    teamId: nullableString(player.team_id),
    teamLogoUrl: nullableString(player.team_logo),
    teamName: nullableString(player.team_name),
    timeFrameCode: nullableString(player.time_frame),
  };
}

function recentMatches(value: unknown, label: string): readonly HistoricalMatch[] {
  const wrapper = asRecord(value, label);
  const groups = arrayOrEmpty(wrapper.matches, `${label}.matches`);
  return groups.flatMap((entry, groupIndex) => {
    const group = asRecord(entry, `${label}.matches[${groupIndex}]`);
    return arrayOrEmpty(group.matches, `${label}.matches[${groupIndex}].matches`).map(
      (match, matchIndex) =>
        historicalMatch(
          match,
          group.tt_info ?? null,
          `${label}.matches[${groupIndex}].matches[${matchIndex}]`,
        ),
    );
  });
}

function rosterPlayerIds(value: unknown, label: string): readonly string[] {
  return asArray(value, label).flatMap((entry, index) => {
    try {
      const id = asString(asRecord(entry, `${label}[${index}]`).id, `${label}[${index}].id`);
      return id === '' ? [] : [id];
    } catch {
      return [];
    }
  });
}

function rosterGroupedPower(
  comparison: Record<string, unknown>,
  power: Record<string, unknown>,
): readonly [readonly PlayerPower[], readonly PlayerPower[]] {
  const rosterIds = [
    rosterPlayerIds(comparison.t1_player_stats, 'analysis.t1.players'),
    rosterPlayerIds(comparison.t2_player_stats, 'analysis.t2.players'),
  ] as const;
  const ownerByPlayerId = new Map<string, 0 | 1>();
  const ambiguousIds = new Set<string>();
  for (const teamIndex of [0, 1] as const) {
    for (const playerId of rosterIds[teamIndex]) {
      const previous = ownerByPlayerId.get(playerId);
      if (previous !== undefined && previous !== teamIndex) ambiguousIds.add(playerId);
      else ownerByPlayerId.set(playerId, teamIndex);
    }
  }
  for (const playerId of ambiguousIds) ownerByPlayerId.delete(playerId);

  const providerGroups = [
    asArray(power.t1_player_stats, 'analysis.power.t1').map((entry, index) =>
      playerPower(entry, `analysis.power.t1[${index}]`),
    ),
    asArray(power.t2_player_stats, 'analysis.power.t2').map((entry, index) =>
      playerPower(entry, `analysis.power.t2[${index}]`),
    ),
  ] as const;
  const grouped: [PlayerPower[], PlayerPower[]] = [[], []];
  for (const providerTeamIndex of [0, 1] as const) {
    for (const player of providerGroups[providerTeamIndex]) {
      grouped[ownerByPlayerId.get(player.playerId) ?? providerTeamIndex].push(player);
    }
  }
  return grouped;
}

export function parseAnalysis(
  payload: unknown,
  matchId: string,
  teamIds: readonly [string, string],
  tournamentId: string,
): MatchAnalysis {
  const data = asRecord(providerData(payload, 'analysis'), 'analysis.data');
  const result = asRecord(data.result, 'analysis.data.result');
  const matchInfo = asRecord(result.mc_info, 'analysis.mc_info');
  if (asString(matchInfo.id, 'analysis.mc_info.id') !== matchId) {
    throw new TypeError('analysis match identity mismatch');
  }
  const analysisTeamIds = [
    asString(asRecord(matchInfo.t1_info, 'analysis.t1_info').id, 'analysis.t1_info.id'),
    asString(asRecord(matchInfo.t2_info, 'analysis.t2_info').id, 'analysis.t2_info.id'),
  ] as const;
  if (analysisTeamIds[0] !== teamIds[0] || analysisTeamIds[1] !== teamIds[1]) {
    throw new TypeError('analysis team identity mismatch');
  }
  const tournament = {
    ...historicalTournament(result.tt_info, 'analysis.tt_info'),
    stage: nullableString(matchInfo.tt_stage),
    stageDescription: nullableString(matchInfo.tt_stage_desc),
  };
  if (tournament.id !== tournamentId) {
    throw new TypeError('analysis tournament identity mismatch');
  }
  const comparison = asRecord(result.comparison, 'analysis.comparison');
  const power = asRecord(result.power_comparison, 'analysis.power_comparison');
  const headToHead = asRecord(result.rec_vs_matches, 'analysis.rec_vs_matches');
  return {
    headToHead: {
      matches: recentMatches({ matches: headToHead.matches }, 'analysis.head_to_head'),
      winRates: [
        { teamId: teamIds[0], winRate: percentNumber(headToHead.t1_win_rate) },
        { teamId: teamIds[1], winRate: percentNumber(headToHead.t2_win_rate) },
      ],
    },
    maps: asArray(comparison.team_map_stats, 'analysis.team_map_stats').map((map, index) =>
      analysisMap(map, teamIds, `analysis.team_map_stats[${index}]`),
    ),
    power: rosterGroupedPower(comparison, power),
    recentMatches: [
      { teamId: teamIds[0], matches: recentMatches(result.t1_rec_matches, 'analysis.t1_recent') },
      { teamId: teamIds[1], matches: recentMatches(result.t2_rec_matches, 'analysis.t2_recent') },
    ],
    stateVersion: asString(data.state_ver, 'analysis.state_ver'),
    tournament,
    teams: [
      analysisTeam(
        teamIds[0],
        comparison.t1_stats,
        comparison.t1_player_stats,
        'analysis.t1',
      ),
      analysisTeam(
        teamIds[1],
        comparison.t2_stats,
        comparison.t2_player_stats,
        'analysis.t2',
      ),
    ],
  };
}
