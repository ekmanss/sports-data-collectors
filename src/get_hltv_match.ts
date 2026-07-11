import { setTimeout as delay } from 'node:timers/promises';
import { captureMatch } from './capture/capture_match.js';
import { emitProgress, normalizeOptions, throwIfAborted } from './config.js';
import { HltvMatchError, asHltvMatchError } from './errors.js';
import { buildConsumerFromCapture } from './transform/build_consumer.js';
import { validateMatch } from './transform/validate_match.js';
import type { GetHltvMatchOptions, GetHltvMatchResult, MatchDiagnostics } from './types.js';

async function retryDelay(options: ReturnType<typeof normalizeOptions>): Promise<void> {
  throwIfAborted(options, 'navigating');
  try {
    await delay(2_000 + Math.floor(Math.random() * 501), undefined, { signal: options.signal });
  } catch (cause) {
    if (options.signal?.aborted) {
      throw new HltvMatchError('capture was aborted', {
        code: 'ABORTED', stage: 'navigating', retryable: false, matchId: String(options.id), cause,
      });
    }
    throw cause;
  }
}

export async function getHltvMatch(
  matchUrl: string,
  input: GetHltvMatchOptions = {},
): Promise<GetHltvMatchResult> {
  const options = normalizeOptions(matchUrl, input);
  const attempts: MatchDiagnostics['attempts'] = [];

  emitProgress(options, { stage: 'validating-input', attempt: 1, message: 'Validated HLTV match URL and options' });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = new Date().toISOString();
    try {
      const capture = await captureMatch(options, attempt);
      attempts.push({
        attempt,
        startedAt: capture.startedAt,
        completedAt: capture.completedAt,
        httpStatus: capture.httpStatus,
      });
      emitProgress(options, { stage: 'building-output', attempt, message: 'Building complete match data' });
      const result = buildConsumerFromCapture(capture, attempts);
      emitProgress(options, { stage: 'validating-output', attempt, message: 'Validating match identity and data consistency' });
      validateMatch(result.data, result.diagnostics, capture.snapshot.page, options.id);
      emitProgress(options, { stage: 'completed', attempt, message: 'Capture completed' });
      return result;
    } catch (error) {
      const normalized = asHltvMatchError(error, {
        code: 'INTERNAL_ERROR', stage: 'extracting-page', retryable: false, matchId: String(options.id),
      });
      attempts.push({
        attempt,
        startedAt,
        completedAt: new Date().toISOString(),
        httpStatus: typeof normalized.details?.httpStatus === 'number' ? normalized.details.httpStatus : null,
        error: { code: normalized.code, message: normalized.message },
      });
      if (!normalized.retryable || attempt === 2) throw normalized;
      emitProgress(options, { stage: 'navigating', attempt, message: 'Transient failure; retrying once' });
      await retryDelay(options);
    }
  }
  throw new HltvMatchError('capture produced no result', {
    code: 'INTERNAL_ERROR', stage: 'extracting-page', retryable: false, matchId: String(options.id),
  });
}
