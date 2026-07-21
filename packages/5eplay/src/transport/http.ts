import { unixMilliseconds } from '../internal/value.js';
import type { UnixMilliseconds } from '../domain/model.js';
import { waitFor } from '../internal/time.js';

export const ESPORTS_DATA_BASE_URL = 'https://esports-data.5eplaycdn.com/v1/api/csgo';
export const COMMUNITY_BASE_URL = 'https://app.5eplay.com/api/score';

export interface JsonHttpResponse {
  readonly kind: 'ok' | 'not-found' | 'client-error' | 'unavailable';
  readonly payload: unknown;
  readonly status: number;
  readonly observedAt: UnixMilliseconds;
  readonly retryAfterMs: number | null;
}

export interface AttemptedJsonHttpResponse extends JsonHttpResponse {
  readonly attempts: number;
}

function retryAfterMilliseconds(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export async function fetchJson(url: string, signal: AbortSignal): Promise<JsonHttpResponse> {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal,
    });
    const observedAt = unixMilliseconds();
    if (response.status === 404) {
      return {
        kind: 'not-found',
        observedAt,
        payload: null,
        retryAfterMs: null,
        status: response.status,
      };
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      return {
        kind: 'client-error',
        observedAt,
        payload: null,
        retryAfterMs: null,
        status: response.status,
      };
    }
    if (!response.ok) {
      return {
        kind: 'unavailable',
        observedAt,
        payload: null,
        retryAfterMs: retryAfterMilliseconds(response),
        status: response.status,
      };
    }
    return {
      kind: 'ok',
      observedAt,
      payload: await response.json(),
      retryAfterMs: null,
      status: response.status,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      kind: 'unavailable',
      observedAt: unixMilliseconds(),
      payload: null,
      retryAfterMs: null,
      status: 0,
    };
  }
}

export async function fetchJsonWithRetry(
  url: string,
  signal: AbortSignal,
  maximumAttempts = 3,
): Promise<AttemptedJsonHttpResponse> {
  let last: JsonHttpResponse | null = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    last = await fetchJson(url, signal);
    if (last.kind !== 'unavailable' || attempt === maximumAttempts) {
      return { ...last, attempts: attempt };
    }
    const delay = last.retryAfterMs ?? 1_000 * 2 ** (attempt - 1);
    await waitFor(delay, signal);
  }
  throw new Error(`unreachable retry state for ${url}: ${String(last)}`);
}

export async function fetchCore(matchId: string, signal: AbortSignal): Promise<JsonHttpResponse> {
  const url = `${ESPORTS_DATA_BASE_URL}/matches/${encodeURIComponent(matchId)}/data`;
  const retryDelays = [1_000, 2_000, 5_000, 10_000, 20_000] as const;
  let response = await fetchJson(url, signal);
  for (const retryDelay of retryDelays) {
    if (response.kind !== 'unavailable') return response;
    await waitFor(response.retryAfterMs ?? retryDelay, signal);
    response = await fetchJson(url, signal);
  }
  return response;
}
