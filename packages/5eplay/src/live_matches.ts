import { asFiveEPlayError, FiveEPlayError } from './errors.js';
import { fetchJson, responseData, type RequestContext } from './http.js';
import { matchIdentityFromInput } from './input.js';
import type {
  FiveEPlayLiveMatch,
  FiveEPlayProgressEvent,
  FiveEPlayScheduleMatch,
  FiveEPlayScheduleMatchMap,
  FiveEPlayScheduleMatchTeam,
  GetFiveEPlayLiveMatchesOptions,
  GetFiveEPlayLiveMatchesResult,
  GetFiveEPlayScheduleOptions,
  GetFiveEPlayScheduleResult,
} from './types.js';
import { integer, record, records, text } from './value.js';

const LIST_PAGE = 'https://event.5eplay.com/csgo/matches' as const;
const LIST_API = 'https://app.5eplay.com/api/tournament/session_list';
const PAGE_SIZE = 20;
const MAX_SCHEDULE_PAGES = 100;

type ListOptions = GetFiveEPlayLiveMatchesOptions | GetFiveEPlayScheduleOptions;

interface ListRequestSpec {
  operation: 'live-matches' | 'schedule';
  stage: 'fetching-live-matches' | 'fetching-schedule';
  kind: 'live-list' | 'schedule-list';
  defaultTimeoutMs: number;
  timeoutDescription: string;
}

const LIVE_LIST_REQUEST: ListRequestSpec = {
  operation: 'live-matches',
  stage: 'fetching-live-matches',
  kind: 'live-list',
  defaultTimeoutMs: 5_000,
  timeoutDescription: 'live-list request',
};

const SCHEDULE_LIST_REQUEST: ListRequestSpec = {
  operation: 'schedule',
  stage: 'fetching-schedule',
  kind: 'schedule-list',
  defaultTimeoutMs: 15_000,
  timeoutDescription: 'schedule request',
};

function emit(
  options: ListOptions,
  spec: ListRequestSpec,
  stage: FiveEPlayProgressEvent['stage'],
  message: string,
): void {
  options.onProgress?.({
    operation: spec.operation,
    stage,
    message,
    timestamp: new Date().toISOString(),
  });
}

function requestLifetime(options: ListOptions, spec: ListRequestSpec): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? spec.defaultTimeoutMs;
  const timeout = setTimeout(() => {
    controller.abort(new FiveEPlayError(
      `5EPlay ${spec.timeoutDescription} timed out after ${timeoutMs}ms`, {
        code: 'TIMEOUT', operation: spec.operation, stage: spec.stage, retryable: true,
      },
    ));
  }, timeoutMs);
  const abort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    },
  };
}

function isLive(value: Record<string, unknown>): boolean {
  const state = record(value.state);
  return state.status === '1' || state.status === 1
    || records(state.bout_states).some((map) => map.status === '1' || map.status === 1);
}

function mapStatus(value: unknown): FiveEPlayScheduleMatchMap['status'] {
  if (value === '1' || value === 1) return 'live';
  if (value === '2' || value === 2) return 'completed';
  if (value === '0' || value === 0 || value === '-1' || value === -1) return 'upcoming';
  return 'unknown';
}

function listTeam(
  value: unknown,
  seriesScore: unknown,
  fallbackId: string,
): FiveEPlayScheduleMatchTeam {
  const source = record(value);
  return {
    id: text(source.id) ?? fallbackId,
    name: text(source.disp_name)?.trim() ?? '',
    country: text(source.country),
    rank: integer(source.rank),
    valveRank: integer(record(source.v_rank).rank),
    seriesScore: integer(seriesScore),
  };
}

function listMap(
  value: unknown,
  matchId: string,
  teams: FiveEPlayScheduleMatchTeam[],
): FiveEPlayScheduleMatchMap | null {
  const source = record(value);
  const number = integer(source.bout_num);
  const name = text(source.map_name)?.trim();
  if (number === null || !name) return null;
  return {
    id: `${matchId}_${number}`,
    number,
    name,
    status: mapStatus(source.status),
    winnerTeamId: source.result === 't1' ? teams[0]?.id ?? null
      : source.result === 't2' ? teams[1]?.id ?? null : null,
    teams: [
      { teamId: teams[0]?.id ?? 't1', score: integer(source.t1_score) },
      { teamId: teams[1]?.id ?? 't2', score: integer(source.t2_score) },
    ],
  };
}

function scheduleStatus(value: Record<string, unknown>): FiveEPlayScheduleMatch['status'] {
  if (isLive(value)) return 'live';
  const status = record(value.state).status;
  if (status === '0' || status === 0 || status === '-1' || status === -1) return 'upcoming';
  return 'unknown';
}

function scheduleMatch(value: unknown): FiveEPlayScheduleMatch | null {
  const source = record(value);
  const matchInfo = record(source.mc_info);
  const state = record(source.state);
  const identity = matchIdentityFromInput(text(matchInfo.id) ?? '');
  if (!identity) return null;
  const teams = [
    listTeam(matchInfo.t1_info, state.t1_score, 't1'),
    listTeam(matchInfo.t2_info, state.t2_score, 't2'),
  ];
  const maps = records(state.bout_states).flatMap((map) => {
    const transformed = listMap(map, identity.id, teams);
    return transformed ? [transformed] : [];
  }).sort((left, right) => left.number - right.number);
  const tournament = record(source.tt_info);
  return {
    id: identity.id,
    numericId: identity.numericId,
    url: identity.url,
    status: scheduleStatus(source),
    bestOf: integer(matchInfo.format),
    scheduledAtUnixSeconds: integer(matchInfo.plan_ts),
    stage: text(matchInfo.tt_stage),
    stageDescription: text(matchInfo.tt_stage_desc),
    tournament: {
      id: text(tournament.id),
      name: text(tournament.disp_name)?.trim() ?? '',
      grade: text(tournament.grade),
      gradeLabel: text(tournament.grade_label),
    },
    teams,
    maps,
    currentMap: maps.find((map) => map.status === 'live') ?? null,
  };
}

function liveMatch(value: unknown): FiveEPlayLiveMatch | null {
  const transformed = scheduleMatch(value);
  if (transformed?.status !== 'live') return null;
  return { ...transformed, status: 'live' };
}

function listContext(
  options: ListOptions,
  spec: ListRequestSpec,
  signal: AbortSignal,
  diagnostics: RequestContext['diagnostics'],
): RequestContext {
  const context: RequestContext = {
    operation: spec.operation,
    signal,
    fetch: options.fetch ?? globalThis.fetch,
    diagnostics,
  };
  if (typeof context.fetch !== 'function') {
    throw new FiveEPlayError('global fetch is unavailable', {
      code: 'INTERNAL_ERROR', operation: spec.operation, stage: spec.stage, retryable: false,
    });
  }
  return context;
}

async function listPage(
  context: RequestContext,
  spec: ListRequestSpec,
  page: number,
): Promise<{ matches: Record<string, unknown>[]; sourceCount: number }> {
  const query = new URLSearchParams({
    game_status: '1',
    game_type: '1',
    grades: '',
    page: String(page),
    limit: String(PAGE_SIZE),
  });
  const response = await fetchJson(context, `${LIST_API}?${query}`, {
    kind: spec.kind, stage: spec.stage, page,
  });
  const data = record(responseData(response, {
    operation: spec.operation, stage: spec.stage,
  }));
  if (!Array.isArray(data.matches)) {
    throw new FiveEPlayError('5EPlay match-list response did not contain a match array', {
      code: 'INVALID_RESPONSE', operation: spec.operation, stage: spec.stage, retryable: true,
    });
  }
  return { matches: records(data.matches), sourceCount: data.matches.length };
}

export async function getFiveEPlayLiveMatches(
  options: GetFiveEPlayLiveMatchesOptions = {},
): Promise<GetFiveEPlayLiveMatchesResult> {
  const spec = LIVE_LIST_REQUEST;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const lifetime = requestLifetime(options, spec);
  const requests: RequestContext['diagnostics'] = [];
  try {
    emit(options, spec, spec.stage, 'Fetching currently live 5EPlay CS2 matches');
    const context = listContext(options, spec, lifetime.signal, requests);
    const matches: FiveEPlayLiveMatch[] = [];
    const seen = new Set<string>();
    for (let page = 1; ; page += 1) {
      const { matches: pageMatches } = await listPage(context, spec, page);
      let newLiveMatches = 0;
      for (const source of pageMatches) {
        const transformed = liveMatch(source);
        if (!transformed || seen.has(transformed.id)) continue;
        seen.add(transformed.id);
        matches.push(transformed);
        newLiveMatches += 1;
      }
      const pageIsEntirelyLive = pageMatches.length === PAGE_SIZE
        && pageMatches.every(isLive);
      if (!pageIsEntirelyLive || newLiveMatches === 0) break;
    }
    const completedAt = new Date().toISOString();
    const result: GetFiveEPlayLiveMatchesResult = {
      data: {
        schemaVersion: '1.0.0',
        capturedAt: completedAt,
        source: { provider: '5eplay', url: LIST_PAGE },
        hasLiveMatches: matches.length > 0,
        matches,
      },
      diagnostics: {
        schemaVersion: '1.0.0',
        operation: 'live-matches',
        startedAt,
        completedAt,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        requests,
      },
    };
    emit(options, spec, 'completed', `Found ${matches.length} live 5EPlay CS2 matches`);
    return result;
  } catch (error) {
    if (lifetime.signal.aborted && lifetime.signal.reason instanceof Error) {
      throw lifetime.signal.reason;
    }
    throw asFiveEPlayError(error, {
      code: 'INTERNAL_ERROR', operation: spec.operation, stage: spec.stage,
      retryable: false,
    });
  } finally {
    lifetime.dispose();
  }
}

export async function getFiveEPlaySchedule(
  options: GetFiveEPlayScheduleOptions = {},
): Promise<GetFiveEPlayScheduleResult> {
  const spec = SCHEDULE_LIST_REQUEST;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const lifetime = requestLifetime(options, spec);
  const requests: RequestContext['diagnostics'] = [];
  try {
    emit(options, spec, spec.stage, 'Fetching the complete current 5EPlay CS2 schedule');
    const context = listContext(options, spec, lifetime.signal, requests);
    const matches: FiveEPlayScheduleMatch[] = [];
    const seen = new Set<string>();
    let complete = false;
    for (let page = 1; page <= MAX_SCHEDULE_PAGES; page += 1) {
      const { matches: pageMatches, sourceCount } = await listPage(context, spec, page);
      let newMatches = 0;
      for (const source of pageMatches) {
        const transformed = scheduleMatch(source);
        if (!transformed || seen.has(transformed.id)) continue;
        seen.add(transformed.id);
        matches.push(transformed);
        newMatches += 1;
      }
      if (sourceCount < PAGE_SIZE) {
        complete = true;
        break;
      }
      if (newMatches === 0) {
        throw new FiveEPlayError('5EPlay schedule pagination returned no new matches', {
          code: 'INVALID_RESPONSE', operation: spec.operation, stage: spec.stage, retryable: true,
          details: { page },
        });
      }
    }
    if (!complete) {
      throw new FiveEPlayError('5EPlay schedule exceeded the pagination safety limit', {
        code: 'INVALID_RESPONSE', operation: spec.operation, stage: spec.stage, retryable: true,
        details: { maxPages: MAX_SCHEDULE_PAGES },
      });
    }
    const completedAt = new Date().toISOString();
    const result: GetFiveEPlayScheduleResult = {
      data: {
        schemaVersion: '1.0.0',
        capturedAt: completedAt,
        source: { provider: '5eplay', url: LIST_PAGE },
        matches,
      },
      diagnostics: {
        schemaVersion: '1.0.0',
        operation: 'schedule',
        startedAt,
        completedAt,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        requests,
      },
    };
    emit(options, spec, 'completed', `Found ${matches.length} current 5EPlay CS2 matches`);
    return result;
  } catch (error) {
    if (lifetime.signal.aborted && lifetime.signal.reason instanceof Error) {
      throw lifetime.signal.reason;
    }
    throw asFiveEPlayError(error, {
      code: 'INTERNAL_ERROR', operation: spec.operation, stage: spec.stage, retryable: false,
    });
  } finally {
    lifetime.dispose();
  }
}
