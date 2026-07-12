import type { Browser } from 'playwright-core';
import { captureMatch, type MatchCaptureOptions } from './capture/capture_match.js';
import { matchIdentityFromUrl } from './config.js';
import { HltvError, asHltvError } from './errors.js';
import {
  abortableDelay,
  emitProgress,
  retryDelayMilliseconds,
  throwIfStopped,
  type OperationContext,
} from './runtime.js';
import { buildConsumerFromCapture } from './transform/build_consumer.js';
import { validateMatch } from './transform/validate_match.js';
import type { GetHltvMatchResult, MatchDiagnostics } from './types.js';

async function retryDelay(
  context: OperationContext,
  matchId: number,
  code: HltvError['code'],
  retryNumber: number,
): Promise<void> {
  await abortableDelay(
    retryDelayMilliseconds(code, retryNumber),
    context,
    'navigating',
    matchId,
  );
}

export async function getMatchWithBrowser(
  browser: Browser,
  matchUrl: string,
  context: OperationContext,
): Promise<GetHltvMatchResult> {
  const identity = typeof matchUrl === 'string' ? matchIdentityFromUrl(matchUrl) : null;
  if (!identity) {
    throw new HltvError('matchUrl must be a canonical https://www.hltv.org/matches/<id>/<slug> URL', {
      code: 'INVALID_INPUT', operation: 'match-detail', stage: 'validating-input', retryable: false,
    });
  }
  throwIfStopped(context, 'validating-input', identity.id);
  const options: MatchCaptureOptions = {
    ...identity,
    context,
    pageSettleMs: 12_000,
    scorebotSettleMs: 10_000,
  };
  const attempts: MatchDiagnostics['attempts'] = [];

  emitProgress(context, { stage: 'validating-input', attempt: 1, message: 'Validated HLTV match URL' });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = new Date().toISOString();
    try {
      const capture = await captureMatch(browser, options, attempt);
      attempts.push({
        attempt,
        startedAt: capture.startedAt,
        completedAt: capture.completedAt,
        httpStatus: capture.httpStatus,
      });
      throwIfStopped(context, 'building-output', options.id);
      emitProgress(context, { stage: 'building-output', attempt, message: 'Building match data' });
      const result = buildConsumerFromCapture(capture, attempts);
      throwIfStopped(context, 'validating-output', options.id);
      emitProgress(context, { stage: 'validating-output', attempt, message: 'Validating match data' });
      validateMatch(result.data, result.diagnostics, capture.snapshot.page, options.id);
      emitProgress(context, { stage: 'completed', attempt, message: 'Match capture completed' });
      return result;
    } catch (error) {
      throwIfStopped(context, 'extracting-page', options.id);
      const normalized = asHltvError(error, {
        code: 'INTERNAL_ERROR', operation: 'match-detail', stage: 'extracting-page', retryable: false,
        matchId: options.id,
      });
      attempts.push({
        attempt,
        startedAt,
        completedAt: new Date().toISOString(),
        httpStatus: typeof normalized.details?.httpStatus === 'number' ? normalized.details.httpStatus : null,
        error: { code: normalized.code, message: normalized.message },
      });
      if (!normalized.retryable || normalized.code === 'ACCESS_BLOCKED' || attempt === 2) {
        throw normalized;
      }
      emitProgress(context, {
        stage: 'navigating',
        attempt,
        message: 'Transient failure; retrying once',
      });
      await retryDelay(context, options.id, normalized.code, attempt);
    }
  }
  throw new HltvError('match capture produced no result', {
    code: 'INTERNAL_ERROR', operation: 'match-detail', stage: 'extracting-page', retryable: false,
    matchId: options.id,
  });
}
