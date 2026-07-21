import type { DataSection } from '../domain/model.js';
import { unixMilliseconds } from '../internal/value.js';
import type { MatchTransport } from '../transport/port.js';

export async function loadSection<T>(
  transport: MatchTransport,
  url: string,
  signal: AbortSignal,
  parse: (payload: unknown) => T,
  isEmpty: (data: T) => boolean,
): Promise<DataSection<T>> {
  let response;
  try {
    response = await transport.fetchJsonWithRetry(url, signal);
  } catch {
    return {
      attempts: 0,
      data: null,
      gap: signal.aborted ? 'DEADLINE' : 'PROVIDER_FAILURE',
      observedAt: unixMilliseconds(),
      status: 'unavailable',
    };
  }
  if (response.kind !== 'ok') {
    return {
      attempts: response.attempts,
      data: null,
      gap: `HTTP_${response.status}`,
      observedAt: response.observedAt,
      status: 'unavailable',
    };
  }
  try {
    const data = parse(response.payload);
    return {
      attempts: response.attempts,
      data,
      gap: null,
      observedAt: response.observedAt,
      status: isEmpty(data) ? 'empty' : 'complete',
    };
  } catch {
    return {
      attempts: response.attempts,
      data: null,
      gap: 'SCHEMA_UNSUPPORTED',
      observedAt: unixMilliseconds(),
      status: 'unavailable',
    };
  }
}
