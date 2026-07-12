import type { Browser, Page } from 'playwright-core';
import { HltvError, asHltvError } from '../errors.js';
import { extractHltvLivePage } from '../extractors/live_page.js';
import {
  abortableDelay,
  emitProgress,
  navigationTimeout,
  throwIfStopped,
  type OperationContext,
} from '../runtime.js';
import type { RawLivePage } from '../types.js';

export interface LiveCaptureAttempt {
  page: RawLivePage;
  capturedAt: string;
  stable: boolean;
  httpStatus: number | null;
  attempt: number;
  startedAt: string;
  completedAt: string;
}

const LIVE_URL = 'https://www.hltv.org/matches';
const LIVE_HYDRATION_TIMEOUT_MS = 25_000;

function classifyHttp(status: number | null): void {
  if (status === 403) {
    throw new HltvError('HLTV denied access to the matches page', {
      code: 'ACCESS_BLOCKED', operation: 'live-list', stage: 'navigating', retryable: false,
    });
  }
  if (status === 429 || (status !== null && status >= 500)) {
    throw new HltvError(`HLTV returned HTTP ${status}`, {
      code: 'NAVIGATION_FAILED', operation: 'live-list', stage: 'navigating', retryable: true,
      details: { httpStatus: status },
    });
  }
}

function validateUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HltvError('HLTV returned an invalid matches URL', {
      code: 'INCOMPLETE_CAPTURE', operation: 'live-list', stage: 'validating-source', retryable: false,
    });
  }
  if (url.protocol !== 'https:' || url.hostname !== 'www.hltv.org' || url.pathname.replace(/\/$/, '') !== '/matches') {
    throw new HltvError('HLTV redirected to an unexpected page', {
      code: 'INCOMPLETE_CAPTURE', operation: 'live-list', stage: 'validating-source', retryable: false,
      details: { finalUrl: value },
    });
  }
}

async function extract(page: Page): Promise<RawLivePage> {
  await page.evaluate('globalThis.__name = (target) => target');
  return await page.evaluate(`(${extractHltvLivePage.toString()})()`) as RawLivePage;
}

function signature(value: RawLivePage): string {
  return JSON.stringify(value.cards.map((card) => ({
    id: card.id,
    teams: card.teams.map((team) => [team.id, team.currentMap, team.mapsWon]),
  })));
}

function hasHydratedLiveState(value: RawLivePage): boolean {
  return value.cards.length > 0 && value.cards.every((card) =>
    card.teams.length === 2 && card.teams.every((team) => team.mapsWon !== null));
}

async function stableSnapshot(
  page: Page,
  context: OperationContext,
  attempt: number,
): Promise<{ page: RawLivePage; stable: boolean }> {
  emitProgress(context, { stage: 'stabilizing', attempt, message: 'Waiting for a stable live snapshot' });
  const started = Date.now();
  let previous: RawLivePage | null = null;
  while (Date.now() - started < LIVE_HYDRATION_TIMEOUT_MS) {
    throwIfStopped(context, 'stabilizing');
    const current = await extract(page);
    if (current.challenge) {
      throw new HltvError('HLTV returned an access challenge', {
        code: 'ACCESS_BLOCKED', operation: 'live-list', stage: 'navigating', retryable: false,
      });
    }
    if (current.recognized && current.cards.length === 0) return { page: current, stable: true };
    if (current.recognized && hasHydratedLiveState(current)
      && previous && hasHydratedLiveState(previous)
      && signature(current) === signature(previous)) {
      return { page: current, stable: true };
    }
    if (current.recognized) previous = current;
    await abortableDelay(500, context, 'stabilizing');
  }
  if (previous) return { page: previous, stable: false };
  throw new HltvError('HLTV matches page structure was not recognized', {
    code: 'INCOMPLETE_CAPTURE', operation: 'live-list', stage: 'extracting-page', retryable: false,
  });
}

export async function captureLiveMatches(
  browser: Browser,
  context: OperationContext,
  attempt: number,
): Promise<LiveCaptureAttempt> {
  const startedAt = new Date().toISOString();
  let page: Page | null = null;
  const stopPage = (): void => { void page?.close().catch(() => undefined); };
  try {
    throwIfStopped(context, 'navigating');
    page = await browser.newPage();
    context.signal.addEventListener('abort', stopPage, { once: true });
    emitProgress(context, { stage: 'navigating', attempt, message: `Opening ${LIVE_URL}` });
    let response;
    try {
      response = await page.goto(LIVE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: navigationTimeout(context),
      });
    } catch (cause) {
      throwIfStopped(context, 'navigating');
      throw new HltvError('failed to navigate to the HLTV matches page', {
        code: 'NAVIGATION_FAILED', operation: 'live-list', stage: 'navigating', retryable: true, cause,
      });
    }
    classifyHttp(response?.status() ?? null);
    validateUrl(page.url());
    emitProgress(context, { stage: 'extracting-page', attempt, message: 'Extracting live match cards' });
    const snapshot = await stableSnapshot(page, context, attempt);
    validateUrl(snapshot.page.url);
    const completedAt = new Date().toISOString();
    return {
      page: snapshot.page,
      capturedAt: completedAt,
      stable: snapshot.stable,
      httpStatus: response?.status() ?? null,
      attempt,
      startedAt,
      completedAt,
    };
  } catch (error) {
    throwIfStopped(context, 'extracting-page');
    throw asHltvError(error, {
      code: 'INTERNAL_ERROR', operation: 'live-list', stage: 'extracting-page', retryable: false,
    });
  } finally {
    context.signal.removeEventListener('abort', stopPage);
    await page?.close().catch(() => undefined);
  }
}
