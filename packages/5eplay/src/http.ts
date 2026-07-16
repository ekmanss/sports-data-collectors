import { FiveEPlayError } from './errors.js';
import type {
  FiveEPlayOperation,
  FiveEPlayRequestDiagnostic,
  FiveEPlayStage,
} from './types.js';

export interface RequestContext {
  operation: FiveEPlayOperation;
  matchId?: string;
  signal: AbortSignal;
  fetch: typeof globalThis.fetch;
  diagnostics: FiveEPlayRequestDiagnostic[];
}

export interface FetchJsonOptions {
  kind: FiveEPlayRequestDiagnostic['kind'];
  stage: FiveEPlayStage;
  method?: 'GET' | 'POST';
  body?: unknown;
  mapNumber?: number;
  tab?: string;
  page?: number;
}

export async function fetchJson(
  context: RequestContext,
  url: string,
  options: FetchJsonOptions,
): Promise<unknown> {
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await context.fetch(url, {
      method: options.method ?? 'GET',
      signal: context.signal,
      headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    if (context.signal.aborted) throw context.signal.reason;
    throw new FiveEPlayError('5EPlay request failed', {
      code: 'HTTP_ERROR',
      operation: context.operation,
      stage: options.stage,
      retryable: true,
      matchId: context.matchId,
      cause: error,
    });
  }
  const body = await response.text();
  context.diagnostics.push({
    kind: options.kind,
    status: response.status,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    bytes: new TextEncoder().encode(body).byteLength,
    ...(options.mapNumber === undefined ? {} : { mapNumber: options.mapNumber }),
    ...(options.tab === undefined ? {} : { tab: options.tab }),
    ...(options.page === undefined ? {} : { page: options.page }),
  });
  if (response.status === 404) {
    throw new FiveEPlayError('5EPlay match was not found', {
      code: 'MATCH_NOT_FOUND', operation: context.operation, stage: options.stage,
      retryable: false, matchId: context.matchId, details: { status: response.status },
    });
  }
  if (!response.ok) {
    throw new FiveEPlayError(`5EPlay request returned HTTP ${response.status}`, {
      code: 'HTTP_ERROR', operation: context.operation, stage: options.stage,
      retryable: response.status === 429 || response.status >= 500,
      matchId: context.matchId, details: { status: response.status },
    });
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new FiveEPlayError('5EPlay returned invalid JSON', {
      code: 'INVALID_RESPONSE', operation: context.operation, stage: options.stage,
      retryable: true, matchId: context.matchId, cause: error,
    });
  }
}

export function responseData(value: unknown, context: {
  operation: FiveEPlayOperation;
  stage: FiveEPlayStage;
  matchId?: string;
}): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FiveEPlayError('5EPlay response envelope is invalid', {
      code: 'INVALID_RESPONSE', retryable: true, ...context,
    });
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.success !== true || !('data' in envelope)) {
    throw new FiveEPlayError('5EPlay response reported failure', {
      code: 'INVALID_RESPONSE', retryable: true, ...context,
      details: {
        errcode: typeof envelope.errcode === 'number' ? envelope.errcode : null,
        message: typeof envelope.message === 'string' ? envelope.message : null,
      },
    });
  }
  return envelope.data;
}
