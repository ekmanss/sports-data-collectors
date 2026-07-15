import type { HltvBrowserAdapter, HltvPageAdapter } from '../browser_adapter.js';
import type { MatchIdentity } from '../config.js';
import { HltvError, asHltvError } from '../errors.js';
import { collectorVersions } from '../metadata.js';
import {
  emitProgress,
  navigationTimeout,
  throwIfStopped,
  type OperationContext,
} from '../runtime.js';
import type { CaptureAttempt, RawSnapshot } from '../types.js';
import {
  classifyMatchPageHttp,
  emptyMatchCaptureTimings,
  validateFinalMatchUrl,
  waitForStableMatchPage,
  type MatchCaptureOptions,
} from './capture_match.js';

const PAGE_READY_TIMEOUT_MS = 12_000;

export async function captureCompletedMatchStats(
  browser: HltvBrowserAdapter,
  identity: MatchIdentity,
  context: OperationContext,
  attempt: number,
): Promise<CaptureAttempt> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const timings = emptyMatchCaptureTimings();
  let page: HltvPageAdapter | undefined;
  let capture: CaptureAttempt | undefined;
  const stopPage = (): void => {
    void page?.close().catch(() => undefined);
  };
  const options: MatchCaptureOptions = {
    ...identity,
    context,
    pageReadyTimeoutMs: PAGE_READY_TIMEOUT_MS,
    scorebotReadyTimeoutMs: 0,
  };

  try {
    throwIfStopped(context, 'navigating', identity.id);
    const metadataStarted = performance.now();
    const versions = await collectorVersions();
    timings.metadataMs = Math.round(performance.now() - metadataStarted);

    const newPageStarted = performance.now();
    page = await browser.newPage();
    timings.newPageMs = Math.round(performance.now() - newPageStarted);
    await page.addInitScript('globalThis.__name = (target) => target');
    context.signal.addEventListener('abort', stopPage, { once: true });

    emitProgress(context, {
      stage: 'navigating',
      attempt,
      message: `Opening completed match ${identity.url}`,
    });
    const navigationStarted = performance.now();
    let response;
    try {
      response = await page.goto(identity.url, {
        waitUntil: 'domcontentloaded',
        timeout: navigationTimeout(context),
      });
    } catch (cause) {
      throwIfStopped(context, 'navigating', identity.id);
      throw new HltvError('failed to navigate to the completed HLTV match page', {
        code: 'NAVIGATION_FAILED',
        operation: 'completed-match-stats',
        stage: 'navigating',
        retryable: true,
        matchId: identity.id,
        cause,
      });
    }
    timings.navigationMs = Math.round(performance.now() - navigationStarted);
    const httpStatus = response?.status() ?? null;
    classifyMatchPageHttp(httpStatus, { context, id: identity.id });
    validateFinalMatchUrl(page.url(), options);

    emitProgress(context, {
      stage: 'extracting-page',
      attempt,
      message: 'Waiting for the completed Match stats matrix',
    });
    const pageReadyStarted = performance.now();
    const extracted = await waitForStableMatchPage(page, options);
    timings.pageReadyMs = Math.round(performance.now() - pageReadyStarted);
    validateFinalMatchUrl(extracted.url, options);
    if (extracted.match.id !== identity.id) {
      throw new HltvError('the completed page contains a different match ID', {
        code: 'INCOMPLETE_CAPTURE',
        operation: 'completed-match-stats',
        stage: 'validating-source',
        retryable: false,
        matchId: identity.id,
        details: { pageId: extracted.match.id },
      });
    }
    if (extracted.sections.cloudflareChallenge) {
      throw new HltvError('HLTV returned an access challenge', {
        code: 'ACCESS_BLOCKED',
        operation: 'completed-match-stats',
        stage: 'navigating',
        retryable: true,
        matchId: identity.id,
      });
    }
    if (!extracted.sections.matchPage) {
      throw new HltvError('the completed HLTV match page root did not load', {
        code: 'NAVIGATION_FAILED',
        operation: 'completed-match-stats',
        stage: 'extracting-page',
        retryable: true,
        matchId: identity.id,
      });
    }
    if (!String(extracted.match.status).toLowerCase().includes('over')) {
      throw new HltvError('completed Match stats require an HLTV match marked over', {
        code: 'INVALID_INPUT',
        operation: 'completed-match-stats',
        stage: 'validating-source',
        retryable: false,
        matchId: identity.id,
        details: { status: extracted.match.status },
      });
    }

    const capturedAt = new Date().toISOString();
    const snapshot: RawSnapshot = {
      capturedAt,
      httpStatus,
      page: extracted,
      scoreboardNormal: null,
      scoreboardAdvanced: null,
      gameLog: {
        scrollHeight: 0,
        chronological: [],
        excludedNoiseEvents: 0,
        positionsVisited: 0,
      },
      note: 'Completed Match stats capture intentionally omits Scorebot.',
    };
    const completedAt = new Date().toISOString();
    capture = {
      initialPage: extracted,
      snapshot,
      collector: versions,
      httpStatus,
      navigationSeconds: Number((timings.navigationMs / 1_000).toFixed(3)),
      totalSeconds: Number(((performance.now() - started) / 1_000).toFixed(3)),
      timings,
      attempt,
      startedAt,
      completedAt,
    };
    return capture;
  } catch (error) {
    throwIfStopped(context, 'extracting-page', identity.id);
    throw asHltvError(error, {
      code: 'INTERNAL_ERROR',
      operation: 'completed-match-stats',
      stage: 'extracting-page',
      retryable: false,
      matchId: identity.id,
    });
  } finally {
    context.signal.removeEventListener('abort', stopPage);
    const closeStarted = performance.now();
    await page?.close().catch(() => undefined);
    if (capture?.timings) {
      capture.timings.pageCloseMs = Math.round(performance.now() - closeStarted);
    }
  }
}
