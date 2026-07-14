import type { Browser } from 'playwright-core';
import {
  captureMatch,
  MatchCaptureSession,
  type MatchCaptureOptions,
} from './capture/capture_match.js';
import { matchIdentityFromUrl } from './config.js';
import { HltvError, asHltvError, withHltvErrorDetails } from './errors.js';
import {
  abortableDelay,
  emitProgress,
  retryDelayMilliseconds,
  throwIfStopped,
  type OperationContext,
} from './runtime.js';
import { buildConsumerFromCapture } from './transform/build_consumer.js';
import { validateMatch } from './transform/validate_match.js';
import type { CaptureAttempt, GetHltvMatchResult, MatchDiagnostics } from './types.js';

const PAGE_READY_TIMEOUT_MS = 12_000;
const SCOREBOT_READY_TIMEOUT_MS = 12_000;

function captureOptions(
  matchUrl: string,
  context: OperationContext,
): MatchCaptureOptions {
  const identity = matchIdentityFromUrl(matchUrl);
  if (!identity) {
    throw new HltvError('matchUrl must be a canonical https://www.hltv.org/matches/<id>/<slug> URL', {
      code: 'INVALID_INPUT', operation: 'match-detail', stage: 'validating-input', retryable: false,
    });
  }
  return {
    ...identity,
    context,
    pageReadyTimeoutMs: PAGE_READY_TIMEOUT_MS,
    scorebotReadyTimeoutMs: SCOREBOT_READY_TIMEOUT_MS,
  };
}

async function buildAndValidate(
  capture: CaptureAttempt,
  attempts: MatchDiagnostics['attempts'],
  context: OperationContext,
  matchId: number,
  attempt: number,
): Promise<GetHltvMatchResult> {
  throwIfStopped(context, 'building-output', matchId);
  emitProgress(context, { stage: 'building-output', attempt, message: 'Building match data' });
  const result = buildConsumerFromCapture(capture, attempts);
  throwIfStopped(context, 'validating-output', matchId);
  emitProgress(context, { stage: 'validating-output', attempt, message: 'Validating match data' });
  validateMatch(result.data, result.diagnostics, capture.snapshot.page, matchId);
  emitProgress(context, { stage: 'completed', attempt, message: 'Match capture completed' });
  return result;
}

export function createMatchCaptureSession(
  browser: Browser,
  matchUrl: string,
): MatchCaptureSession {
  const identity = matchIdentityFromUrl(matchUrl);
  if (!identity) {
    throw new HltvError('matchUrl must be a canonical https://www.hltv.org/matches/<id>/<slug> URL', {
      code: 'INVALID_INPUT', operation: 'match-detail', stage: 'validating-input', retryable: false,
    });
  }
  return new MatchCaptureSession(browser, {
    ...identity,
    pageReadyTimeoutMs: PAGE_READY_TIMEOUT_MS,
    scorebotReadyTimeoutMs: SCOREBOT_READY_TIMEOUT_MS,
  });
}

export async function getMatchWithSession(
  session: MatchCaptureSession,
  matchUrl: string,
  context: OperationContext,
  attempt = 1,
): Promise<GetHltvMatchResult> {
  const options = captureOptions(matchUrl, context);
  if (options.id !== session.id) {
    throw new HltvError('the match session belongs to a different match', {
      code: 'INVALID_INPUT', operation: 'match-detail', stage: 'validating-input', retryable: false,
      matchId: options.id, details: { sessionMatchId: session.id },
    });
  }
  throwIfStopped(context, 'validating-input', options.id);
  const attempts: MatchDiagnostics['attempts'] = [];
  const startedAt = new Date().toISOString();
  try {
    const capture = await session.capture(context, attempt);
    attempts.push({
      attempt,
      startedAt: capture.startedAt,
      completedAt: capture.completedAt,
      httpStatus: capture.httpStatus,
    });
    return await buildAndValidate(capture, attempts, context, options.id, attempt);
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
    throw withHltvErrorDetails(normalized, { attempts });
  }
}

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
  const options = captureOptions(matchUrl, context);
  throwIfStopped(context, 'validating-input', options.id);
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
      return await buildAndValidate(capture, attempts, context, options.id, attempt);
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
        throw withHltvErrorDetails(normalized, { attempts });
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
