import type {
  ScheduleMap,
  ScheduleMatch,
  SchedulePageResult,
  ScheduleTeam,
  ScheduleTournament,
  UnixMilliseconds,
} from '../domain/model.js';
import {
  asArray,
  asRecord,
  asString,
  deepFreeze,
  nullableNumber,
  nullableString,
  secondsToMilliseconds,
} from '../internal/value.js';
import type { MatchTransport } from '../transport/port.js';

export const SCHEDULE_PAGE_SIZE = 20 as const;
const SCHEDULE_ENDPOINT = 'https://app.5eplay.com/api/tournament/session_list';
const MATCH_ID = /^csgo_mc_[1-9]\d*$/;

class ScheduleProviderUnavailableError extends Error {}

function scheduleUrl(page: number): string {
  return `${SCHEDULE_ENDPOINT}?game_status=1&game_type=1&grades=&page=${page}&limit=${SCHEDULE_PAGE_SIZE}`;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number = nullableNumber(value);
  if (number === null || !Number.isInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return number;
}

function optionalPositiveInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const number = nullableNumber(value);
  if (number === null || !Number.isInteger(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive integer when present`);
  }
  return number;
}

function optionalScore(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  return nonNegativeInteger(value, label);
}

function team(
  value: unknown,
  label: string,
  seriesScore: unknown,
): ScheduleTeam {
  const providerTeam = asRecord(value, label);
  const virtualRankValue = providerTeam.v_rank;
  const virtualRank =
    virtualRankValue === null || virtualRankValue === undefined
      ? null
      : optionalPositiveInteger(
          asRecord(virtualRankValue, `${label}.v_rank`).rank,
          `${label}.v_rank.rank`,
        );
  return {
    country: nullableString(providerTeam.country),
    id: nullableString(providerTeam.id),
    logoUrl: nullableString(providerTeam.logo),
    name: asString(providerTeam.disp_name, `${label}.disp_name`),
    rank: optionalPositiveInteger(providerTeam.rank, `${label}.rank`),
    seriesScore: nonNegativeInteger(seriesScore, `${label}.seriesScore`),
    virtualRank,
  };
}

function tournament(value: unknown, label: string): ScheduleTournament {
  const providerTournament = asRecord(value, label);
  return {
    coverUrl: nullableString(providerTournament.cover),
    gradeCode: nullableString(providerTournament.grade),
    gradeLabel: nullableString(providerTournament.grade_label),
    id: asString(providerTournament.id, `${label}.id`),
    location: nullableString(providerTournament.city_name),
    logoUrl: nullableString(providerTournament.logo),
    name: asString(providerTournament.disp_name, `${label}.disp_name`),
    prize: nullableString(providerTournament.bonus),
    providerLocalEndTime: nullableString(providerTournament.end_time),
    providerLocalStartTime: nullableString(providerTournament.start_time),
    providerStatus: nullableString(providerTournament.status),
  };
}

function mapStatus(value: unknown, label: string): ScheduleMap['status'] {
  const code = nonNegativeInteger(value === '-1' ? 0 : value, label);
  if (code === 0) return 'unopened';
  if (code === 1) return 'live';
  if (code === 2) return 'settled';
  throw new TypeError(`${label} uses an unsupported status code`);
}

function mapWinner(
  result: unknown,
  status: ScheduleMap['status'],
  teamIds: readonly [string, string],
  scores: readonly [number | null, number | null],
): string | null {
  if (status !== 'settled') return null;
  if (result === teamIds[0] || result === 't1' || result === '1' || result === 1) {
    return teamIds[0];
  }
  if (result === teamIds[1] || result === 't2' || result === '2' || result === 2) {
    return teamIds[1];
  }
  if (scores[0] !== null && scores[1] !== null && scores[0] !== scores[1]) {
    return scores[0] > scores[1] ? teamIds[0] : teamIds[1];
  }
  return null;
}

function scheduleMap(
  value: unknown,
  label: string,
  teamIds: readonly [string, string],
): ScheduleMap {
  const providerMap = asRecord(value, label);
  const mapNumber = optionalPositiveInteger(providerMap.bout_num, `${label}.bout_num`);
  if (mapNumber === null) throw new TypeError(`${label}.bout_num is required`);
  const status = mapStatus(providerMap.status, `${label}.status`);
  const scores = [
    optionalScore(providerMap.t1_score, `${label}.t1_score`),
    optionalScore(providerMap.t2_score, `${label}.t2_score`),
  ] as const;
  return {
    mapNumber,
    name: nullableString(providerMap.map_name),
    status,
    teams: [
      { score: scores[0], teamId: teamIds[0] },
      { score: scores[1], teamId: teamIds[1] },
    ],
    winnerTeamId: mapWinner(providerMap.result, status, teamIds, scores),
  };
}

function providerStatus(value: unknown, label: string): 'completed' | 'live' | 'upcoming' {
  const status = Number(asString(value, label));
  if (status === -1 || status === 0) return 'upcoming';
  if (status === 1) return 'live';
  if (status === 2) return 'completed';
  throw new TypeError(`${label} uses an unsupported status code`);
}

function scheduleMatch(value: unknown, index: number): ScheduleMatch | null {
  const label = `data.matches[${index}]`;
  const providerMatch = asRecord(value, label);
  const matchInfo = asRecord(providerMatch.mc_info, `${label}.mc_info`);
  const state = asRecord(providerMatch.state, `${label}.state`);
  const id = asString(matchInfo.id, `${label}.mc_info.id`);
  if (!MATCH_ID.test(id)) throw new TypeError(`${label}.mc_info.id is unsupported`);
  const status = providerStatus(state.status, `${label}.state.status`);

  const firstTeam = team(
    matchInfo.t1_info,
    `${label}.mc_info.t1_info`,
    state.t1_score,
  );
  const secondTeam = team(
    matchInfo.t2_info,
    `${label}.mc_info.t2_info`,
    state.t2_score,
  );
  if (firstTeam.id !== null && firstTeam.id === secondTeam.id) {
    throw new TypeError(`${label} repeats the same team identity`);
  }
  const providerMaps = asArray(state.bout_states, `${label}.state.bout_states`);
  const teamIds =
    firstTeam.id === null || secondTeam.id === null
      ? null
      : ([firstTeam.id, secondTeam.id] as const);
  if (status !== 'upcoming' && teamIds === null) {
    throw new TypeError(`${label} cannot bind active map data to unknown teams`);
  }
  let maps: readonly ScheduleMap[];
  if (providerMaps.length === 0) {
    maps = [];
  } else {
    if (teamIds === null) {
      throw new TypeError(`${label} cannot bind map data to unknown teams`);
    }
    maps = providerMaps.map((map, mapIndex) =>
      scheduleMap(map, `${label}.state.bout_states[${mapIndex}]`, teamIds),
    );
  }
  if (new Set(maps.map((map) => map.mapNumber)).size !== maps.length) {
    throw new TypeError(`${label} repeats a map number`);
  }
  const liveMaps = maps.filter((map) => map.status === 'live');
  if (liveMaps.length > 1) throw new TypeError(`${label} has more than one live map`);
  if (status === 'completed') {
    if (liveMaps.length > 0) {
      throw new TypeError(`${label} is completed while a map is live`);
    }
    return null;
  }
  if (
    status === 'upcoming' &&
    liveMaps.length === 0 &&
    maps.some((map) => map.status === 'settled')
  ) {
    throw new TypeError(`${label} is upcoming after a map settled`);
  }
  const liveByMap = liveMaps.length === 1;
  const effectiveStatus = liveByMap ? 'live' : status;

  return {
    bestOf: optionalPositiveInteger(matchInfo.format, `${label}.mc_info.format`),
    currentMapNumber:
      liveMaps[0]?.mapNumber ?? (effectiveStatus === 'live' && maps.length === 0 ? 1 : null),
    id,
    maps,
    scheduledAt: secondsToMilliseconds(matchInfo.plan_ts),
    stage: nullableString(matchInfo.tt_stage),
    stageDescription: nullableString(matchInfo.tt_stage_desc),
    status: effectiveStatus,
    teams: [firstTeam, secondTeam],
    tournament: tournament(providerMatch.tt_info, `${label}.tt_info`),
    url: `https://event.5eplay.com/csgo/matches/${id}`,
  };
}

function decodeSchedule(
  payload: unknown,
  page: number,
  observedAt: UnixMilliseconds,
): SchedulePageResult {
  const root = asRecord(payload, 'schedule response');
  const errorCode = nullableNumber(root.errcode);
  if (typeof root.success !== 'boolean' || errorCode === null) {
    throw new TypeError('schedule response envelope is invalid');
  }
  if (!root.success || errorCode !== 0) {
    throw new ScheduleProviderUnavailableError('schedule response reports an operational failure');
  }
  const data = asRecord(root.data, 'schedule response.data');
  const sourceMatches = asArray(data.matches, 'schedule response.data.matches');
  const sourceMatchIds = sourceMatches.map((match, index) => {
    const providerMatch = asRecord(match, `data.matches[${index}]`);
    const matchInfo = asRecord(providerMatch.mc_info, `data.matches[${index}].mc_info`);
    return asString(matchInfo.id, `data.matches[${index}].mc_info.id`);
  });
  if (new Set(sourceMatchIds).size !== sourceMatchIds.length) {
    throw new TypeError('schedule response repeats a match identity');
  }
  const matches: ScheduleMatch[] = [];
  let decodedRows = 0;
  for (const [index, sourceMatch] of sourceMatches.entries()) {
    try {
      const decoded = scheduleMatch(sourceMatch, index);
      decodedRows += 1;
      if (decoded !== null) matches.push(decoded);
    } catch {
      // A single provider row can transiently contradict itself while the other
      // rows on the page remain useful. Page-level identity checks above still
      // fail closed because they cannot be isolated safely.
    }
  }
  if (sourceMatches.length > 0 && decodedRows === 0) {
    throw new TypeError('schedule response contains no independently decodable match rows');
  }
  return deepFreeze({
    kind: 'available',
    schedule: {
      matches,
      mayHaveNextPage: sourceMatches.length === SCHEDULE_PAGE_SIZE,
      observedAt,
      page,
      pageSize: SCHEDULE_PAGE_SIZE,
      providerStateVersion: nullableString(data.state_ver),
      schema: 'fiveeplay-schedule/v1',
      sourceCount: sourceMatches.length,
    },
  });
}

export async function loadSchedulePage(
  transport: MatchTransport,
  page: number,
  signal: AbortSignal,
): Promise<SchedulePageResult> {
  const response = await transport.fetchJsonWithRetry(scheduleUrl(page), signal);
  if (response.kind !== 'ok') {
    return {
      kind: 'blocked',
      observedAt: response.observedAt,
      page,
      reason: 'provider-unavailable',
    };
  }
  try {
    return decodeSchedule(response.payload, page, response.observedAt);
  } catch (error) {
    return {
      kind: 'blocked',
      observedAt: response.observedAt,
      page,
      reason:
        error instanceof ScheduleProviderUnavailableError
          ? 'provider-unavailable'
          : 'provider-schema-unsupported',
    };
  }
}
