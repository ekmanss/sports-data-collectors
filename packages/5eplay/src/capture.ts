import { asFiveEPlayError, FiveEPlayError } from './errors.js';
import { fetchJson, responseData, type RequestContext } from './http.js';
import { requireMatchIdentity } from './input.js';
import {
  buildFiveEPlayMatch,
  type CommunityCapture,
  type LogCapture,
} from './transform.js';
import type {
  FiveEPlayClientOptions,
  FiveEPlayDiagnosticWarning,
  FiveEPlayMatchIdentity,
  FiveEPlayProgressEvent,
  FiveEPlayRequestOptions,
  GetFiveEPlayMatchResult,
} from './types.js';
import { integer, record, records, text } from './value.js';

const DATA_API = 'https://esports-data.5eplaycdn.com/v1/api/csgo';
const COMMUNITY_API = 'https://app.5eplay.com/api/score';

export interface CapturedFiveEPlayMatch {
  result: GetFiveEPlayMatchResult;
  identity: FiveEPlayMatchIdentity;
  detailData: unknown;
  analysisData: unknown | null;
  logs: Map<number, LogCapture>;
  community: CommunityCapture | null;
}

function emit(
  options: FiveEPlayRequestOptions,
  stage: FiveEPlayProgressEvent['stage'],
  message: string,
): void {
  options.onProgress?.({
    operation: 'match-detail',
    stage,
    message,
    timestamp: new Date().toISOString(),
  });
}

function requestLifetime(options: FiveEPlayRequestOptions): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const timeout = setTimeout(() => {
    controller.abort(new FiveEPlayError(`5EPlay operation timed out after ${timeoutMs}ms`, {
      code: 'TIMEOUT', operation: 'match-detail', stage: 'fetching-match', retryable: true,
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

function matchApi(identity: FiveEPlayMatchIdentity, suffix: string): string {
  return `${DATA_API}/matches/${identity.id}/${suffix}`;
}

async function optionalData<T>(
  task: () => Promise<T>,
  warnings: FiveEPlayDiagnosticWarning[],
  section: string,
): Promise<T | null> {
  try {
    return await task();
  } catch (error) {
    warnings.push({
      code: 'OPTIONAL_SECTION_UNAVAILABLE',
      section,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function captureLogs(
  context: RequestContext,
  identity: FiveEPlayMatchIdentity,
  detailData: unknown,
): Promise<Map<number, LogCapture>> {
  const sourceMatch = record(record(detailData).match);
  const activeBouts = records(sourceMatch.bouts_state).flatMap((bout) => {
    const number = integer(bout.bout_num);
    const status = integer(bout.status);
    return number !== null && (status === 1 || status === 2) ? [{ number }] : [];
  });
  const entries = await Promise.all(activeBouts.map(async ({ number }) => {
    const url = `${DATA_API}/match/${identity.id}/event/log?update_version=0&limit=500&bout_id=${identity.id}_${number}`;
    const response = await fetchJson(context, url, {
      kind: 'log', stage: 'fetching-logs', mapNumber: number,
    });
    const data = record(responseData(response, {
      operation: 'match-detail', stage: 'fetching-logs', matchId: identity.id,
    }));
    return [number, {
      complete: data.not_more === '1' || data.not_more === 1,
      fromVersion: text(data.from_ver),
      toVersion: text(data.to_ver),
      rows: Array.isArray(data.list) ? data.list : [],
    }] as const;
  }));
  return new Map(entries);
}

async function captureCommunity(
  context: RequestContext,
  identity: FiveEPlayMatchIdentity,
  tabsData: unknown,
): Promise<CommunityCapture> {
  const tabs = Array.isArray(tabsData) ? tabsData : [];
  const entries = await Promise.all(tabs.map(async (rawTab) => {
    const tab = record(rawTab);
    const tabName = text(tab.tab) ?? '';
    const id = text(tab.id) ?? '';
    const query = new URLSearchParams({
      match_id: identity.id,
      tab: tabName,
      game_type: '1',
      team_id: id,
    });
    const response = await fetchJson(context, `${COMMUNITY_API}/match_score_list?${query}`, {
      kind: 'community-list', stage: 'fetching-community', tab: `${tabName}:${id}`,
    });
    const cards = responseData(response, {
      operation: 'match-detail', stage: 'fetching-community', matchId: identity.id,
    });
    return [`${tabName}:${id}`, Array.isArray(cards) ? cards : []] as const;
  }));
  return { tabs, cardsByTab: new Map(entries) };
}

export async function captureFiveEPlayMatch(
  input: string,
  clientOptions: FiveEPlayClientOptions = {},
  requestOptions: FiveEPlayRequestOptions = {},
): Promise<CapturedFiveEPlayMatch> {
  const startedAt = new Date().toISOString();
  emit(requestOptions, 'validating-input', 'Validating 5EPlay match input');
  const identity = requireMatchIdentity(input);
  const lifetime = requestLifetime(requestOptions);
  const diagnostics: RequestContext['diagnostics'] = [];
  const warnings: FiveEPlayDiagnosticWarning[] = [];
  const context: RequestContext = {
    operation: 'match-detail',
    matchId: identity.id,
    signal: lifetime.signal,
    fetch: clientOptions.fetch ?? globalThis.fetch,
    diagnostics,
  };
  if (typeof context.fetch !== 'function') {
    lifetime.dispose();
    throw new FiveEPlayError('global fetch is unavailable', {
      code: 'INTERNAL_ERROR', operation: 'match-detail', stage: 'fetching-match', retryable: false,
      matchId: identity.id,
    });
  }
  try {
    emit(requestOptions, 'fetching-match', 'Fetching 5EPlay match snapshot');
    const detailPromise = fetchJson(context, matchApi(identity, 'data'), {
      kind: 'match', stage: 'fetching-match',
    }).then((value) => responseData(value, {
      operation: 'match-detail', stage: 'fetching-match', matchId: identity.id,
    }));
    const analysisPromise = requestOptions.includeAnalysis === false ? Promise.resolve(null)
      : optionalData(async () => {
        emit(requestOptions, 'fetching-analysis', 'Fetching pre-match analysis');
        const value = await fetchJson(context, matchApi(identity, 'analysis_v1'), {
          kind: 'analysis', stage: 'fetching-analysis',
        });
        return responseData(value, {
          operation: 'match-detail', stage: 'fetching-analysis', matchId: identity.id,
        });
      }, warnings, 'analysis');
    const tabsPromise = requestOptions.includeCommunityRatings === false ? Promise.resolve(null)
      : optionalData(async () => {
        emit(requestOptions, 'fetching-community', 'Fetching community rating tabs');
        const query = new URLSearchParams({ match_id: identity.id, game_type: '1' });
        const value = await fetchJson(context, `${COMMUNITY_API}/match_score_tab?${query}`, {
          kind: 'community-tabs', stage: 'fetching-community',
        });
        return responseData(value, {
          operation: 'match-detail', stage: 'fetching-community', matchId: identity.id,
        });
      }, warnings, 'communityRatings');
    const [detailData, analysisData, tabsData] = await Promise.all([
      detailPromise, analysisPromise, tabsPromise,
    ]);
    const sourceId = text(record(record(record(detailData).match).mc_info).id);
    if (sourceId !== identity.id) {
      throw new FiveEPlayError('5EPlay match payload identity does not match the request', {
        code: 'INVALID_RESPONSE', operation: 'match-detail', stage: 'fetching-match',
        retryable: true, matchId: identity.id, details: { sourceId },
      });
    }
    const logsPromise = requestOptions.includeLogs === false
      ? Promise.resolve(new Map<number, LogCapture>())
      : (emit(requestOptions, 'fetching-logs', 'Fetching complete map logs'),
        captureLogs(context, identity, detailData));
    const communityPromise = tabsData === null ? Promise.resolve(null)
      : optionalData(
        () => captureCommunity(context, identity, tabsData),
        warnings,
        'communityRatings',
      );
    const [logs, community] = await Promise.all([logsPromise, communityPromise]);
    emit(requestOptions, 'building-output', 'Building typed 5EPlay match output');
    const capturedAt = new Date().toISOString();
    const data = buildFiveEPlayMatch({
      identity, capturedAt, detailData, analysisData, logs, community,
    });
    const completedAt = new Date().toISOString();
    const result: GetFiveEPlayMatchResult = {
      data,
      diagnostics: {
        schemaVersion: '1.0.0',
        operation: 'match-detail',
        startedAt,
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        input: identity,
        requests: diagnostics,
        warnings,
      },
    };
    emit(requestOptions, 'completed', '5EPlay match capture completed');
    return { result, identity, detailData, analysisData, logs, community };
  } catch (error) {
    if (lifetime.signal.aborted && lifetime.signal.reason instanceof Error) {
      throw lifetime.signal.reason;
    }
    throw asFiveEPlayError(error, {
      code: 'INTERNAL_ERROR', operation: 'match-detail', stage: 'fetching-match',
      retryable: false, matchId: identity.id,
    });
  } finally {
    lifetime.dispose();
  }
}
