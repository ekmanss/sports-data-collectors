import type { HltvBrowserAdapter } from './browser_adapter.js';
import { captureCompletedMatchStats } from './capture/capture_completed_match_stats.js';
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
import type {
  CompletedMatchStatsDiagnostics,
  GetHltvCompletedMatchStatsResult,
} from './types.js';

export async function getCompletedMatchStatsWithBrowser(
  browser: HltvBrowserAdapter,
  matchUrl: string,
  context: OperationContext,
): Promise<GetHltvCompletedMatchStatsResult> {
  const identity = matchIdentityFromUrl(matchUrl);
  if (!identity) {
    throw new HltvError(
      'matchUrl must be a canonical https://www.hltv.org/matches/<id>/<slug> URL',
      {
        code: 'INVALID_INPUT',
        operation: 'completed-match-stats',
        stage: 'validating-input',
        retryable: false,
      },
    );
  }
  throwIfStopped(context, 'validating-input', identity.id);
  emitProgress(context, {
    stage: 'validating-input',
    attempt: 1,
    message: 'Validated completed HLTV match URL',
  });
  const attempts: CompletedMatchStatsDiagnostics['attempts'] = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = new Date().toISOString();
    try {
      const capture = await captureCompletedMatchStats(browser, identity, context, attempt);
      attempts.push({
        attempt,
        startedAt: capture.startedAt,
        completedAt: capture.completedAt,
        httpStatus: capture.httpStatus,
      });
      throwIfStopped(context, 'building-output', identity.id);
      emitProgress(context, {
        stage: 'building-output',
        attempt,
        message: 'Building completed Match stats data',
      });
      const full = buildConsumerFromCapture(capture, attempts);
      validateMatch(full.data, full.diagnostics, capture.snapshot.page, identity.id);
      const warnings = full.data.matchStats.views.length === 0
        ? [{
            code: 'MATCH_STATS_NOT_PUBLISHED',
            reason: 'HLTV has not published Match stats for this completed match.',
          }]
        : [];
      const completedAt = new Date().toISOString();
      const result: GetHltvCompletedMatchStatsResult = {
        data: {
          schemaVersion: '1.0.0',
          capturedAt: full.data.capturedAt,
          sport: 'cs2',
          source: full.data.source,
          match: full.data.match,
          teams: full.data.teams,
          players: full.data.players,
          maps: full.data.maps.map((map) => ({
            name: map.name,
            score: map.score,
            halves: map.halves,
          })),
          availability: full.data.matchStats.views.length > 0 ? 'available' : 'not-published',
          matchStats: full.data.matchStats,
        },
        diagnostics: {
          schemaVersion: '1.0.0',
          operation: 'completed-match-stats',
          startedAt: attempts[0]?.startedAt ?? capture.startedAt,
          completedAt,
          durationMs: Math.max(
            0,
            Date.parse(completedAt) - Date.parse(attempts[0]?.startedAt ?? capture.startedAt),
          ),
          collector: capture.collector,
          input: identity,
          attempts,
          capture: {
            httpStatus: capture.httpStatus,
            navigationSeconds: capture.navigationSeconds,
            totalSeconds: capture.totalSeconds,
            timings: capture.timings!,
          },
          warnings,
        },
      };
      emitProgress(context, {
        stage: 'completed',
        attempt,
        message: 'Completed Match stats capture completed',
      });
      return result;
    } catch (error) {
      throwIfStopped(context, 'extracting-page', identity.id);
      const normalized = asHltvError(error, {
        code: 'INTERNAL_ERROR',
        operation: 'completed-match-stats',
        stage: 'extracting-page',
        retryable: false,
        matchId: identity.id,
      });
      attempts.push({
        attempt,
        startedAt,
        completedAt: new Date().toISOString(),
        httpStatus:
          typeof normalized.details?.httpStatus === 'number'
            ? normalized.details.httpStatus
            : null,
        error: { code: normalized.code, message: normalized.message },
      });
      if (!normalized.retryable || normalized.code === 'ACCESS_BLOCKED' || attempt === 2) {
        throw withHltvErrorDetails(normalized, { attempts });
      }
      emitProgress(context, {
        stage: 'navigating',
        attempt,
        message: 'Transient completed Match stats failure; retrying once',
      });
      await abortableDelay(
        retryDelayMilliseconds(normalized.code, attempt),
        context,
        'navigating',
        identity.id,
      );
    }
  }

  throw new HltvError('completed Match stats capture produced no result', {
    code: 'INTERNAL_ERROR',
    operation: 'completed-match-stats',
    stage: 'extracting-page',
    retryable: false,
    matchId: identity.id,
  });
}
