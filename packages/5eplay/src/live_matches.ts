import { asFiveEPlayError, FiveEPlayError } from './errors.js';
import { fetchJson, responseData, type RequestContext } from './http.js';
import { matchIdentityFromInput } from './input.js';
import type {
  FiveEPlayLiveMatch,
  FiveEPlayLiveMatchMap,
  FiveEPlayLiveMatchTeam,
  FiveEPlayProgressEvent,
  GetFiveEPlayLiveMatchesOptions,
  GetFiveEPlayLiveMatchesResult,
} from './types.js';
import { integer, record, records, text } from './value.js';

const LIST_PAGE = 'https://event.5eplay.com/csgo/matches' as const;
const LIST_API = 'https://app.5eplay.com/api/tournament/session_list';
const PAGE_SIZE = 20;

function emit(
  options: GetFiveEPlayLiveMatchesOptions,
  stage: FiveEPlayProgressEvent['stage'],
  message: string,
): void {
  options.onProgress?.({
    operation: 'live-matches',
    stage,
    message,
    timestamp: new Date().toISOString(),
  });
}

function requestLifetime(options: GetFiveEPlayLiveMatchesOptions): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const timeout = setTimeout(() => {
    controller.abort(new FiveEPlayError(`5EPlay live-list request timed out after ${timeoutMs}ms`, {
      code: 'TIMEOUT', operation: 'live-matches', stage: 'fetching-live-matches', retryable: true,
    }));
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

function mapStatus(value: unknown): FiveEPlayLiveMatchMap['status'] {
  if (value === '1' || value === 1) return 'live';
  if (value === '2' || value === 2) return 'completed';
  if (value === '0' || value === 0 || value === '-1' || value === -1) return 'upcoming';
  return 'unknown';
}

function liveTeam(
  value: unknown,
  seriesScore: unknown,
  fallbackId: string,
): FiveEPlayLiveMatchTeam {
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

function liveMap(
  value: unknown,
  matchId: string,
  teams: FiveEPlayLiveMatchTeam[],
): FiveEPlayLiveMatchMap | null {
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

function liveMatch(value: unknown): FiveEPlayLiveMatch | null {
  const source = record(value);
  if (!isLive(source)) return null;
  const matchInfo = record(source.mc_info);
  const state = record(source.state);
  const identity = matchIdentityFromInput(text(matchInfo.id) ?? '');
  if (!identity) return null;
  const teams = [
    liveTeam(matchInfo.t1_info, state.t1_score, 't1'),
    liveTeam(matchInfo.t2_info, state.t2_score, 't2'),
  ];
  const maps = records(state.bout_states).flatMap((map) => {
    const transformed = liveMap(map, identity.id, teams);
    return transformed ? [transformed] : [];
  }).sort((left, right) => left.number - right.number);
  const tournament = record(source.tt_info);
  return {
    id: identity.id,
    numericId: identity.numericId,
    url: identity.url,
    status: 'live',
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

export async function getFiveEPlayLiveMatches(
  options: GetFiveEPlayLiveMatchesOptions = {},
): Promise<GetFiveEPlayLiveMatchesResult> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const lifetime = requestLifetime(options);
  const requests: RequestContext['diagnostics'] = [];
  const context: RequestContext = {
    operation: 'live-matches',
    signal: lifetime.signal,
    fetch: options.fetch ?? globalThis.fetch,
    diagnostics: requests,
  };
  if (typeof context.fetch !== 'function') {
    lifetime.dispose();
    throw new FiveEPlayError('global fetch is unavailable', {
      code: 'INTERNAL_ERROR', operation: 'live-matches', stage: 'fetching-live-matches',
      retryable: false,
    });
  }
  emit(options, 'fetching-live-matches', 'Fetching currently live 5EPlay CS2 matches');
  try {
    const matches: FiveEPlayLiveMatch[] = [];
    const seen = new Set<string>();
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({
        game_status: '1',
        game_type: '1',
        grades: '',
        page: String(page),
        limit: String(PAGE_SIZE),
      });
      const response = await fetchJson(context, `${LIST_API}?${query}`, {
        kind: 'live-list', stage: 'fetching-live-matches', page,
      });
      const data = record(responseData(response, {
        operation: 'live-matches', stage: 'fetching-live-matches',
      }));
      if (!Array.isArray(data.matches)) {
        throw new FiveEPlayError('5EPlay live-list response did not contain a match array', {
          code: 'INVALID_RESPONSE', operation: 'live-matches', stage: 'fetching-live-matches',
          retryable: true,
        });
      }
      const pageMatches = records(data.matches);
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
    emit(options, 'completed', `Found ${matches.length} live 5EPlay CS2 matches`);
    return result;
  } catch (error) {
    if (lifetime.signal.aborted && lifetime.signal.reason instanceof Error) {
      throw lifetime.signal.reason;
    }
    throw asFiveEPlayError(error, {
      code: 'INTERNAL_ERROR', operation: 'live-matches', stage: 'fetching-live-matches',
      retryable: false,
    });
  } finally {
    lifetime.dispose();
  }
}
