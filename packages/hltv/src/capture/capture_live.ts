import type { HltvBrowserAdapter, HltvPageAdapter } from '../browser_adapter.js';
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
  session: {
    reused: boolean;
    navigated: boolean;
    ageMs: number;
  };
}

const LIVE_URL = 'https://www.hltv.org/matches';
const LIVE_HYDRATION_TIMEOUT_MS = 25_000;

function classifyHttp(status: number | null): void {
  if (status === 403) {
    throw new HltvError('HLTV denied access to the matches page', {
      code: 'ACCESS_BLOCKED', operation: 'live-list', stage: 'navigating', retryable: true,
      details: { httpStatus: status },
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

async function extract(page: HltvPageAdapter): Promise<RawLivePage> {
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
  page: HltvPageAdapter,
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
        code: 'ACCESS_BLOCKED', operation: 'live-list', stage: 'navigating', retryable: true,
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

async function currentSnapshot(
  page: HltvPageAdapter,
  context: OperationContext,
  attempt: number,
): Promise<{ page: RawLivePage; stable: boolean }> {
  const current = await extract(page);
  if (current.challenge) {
    throw new HltvError('HLTV returned an access challenge', {
      code: 'ACCESS_BLOCKED', operation: 'live-list', stage: 'navigating', retryable: true,
    });
  }
  if (current.recognized && (current.cards.length === 0 || hasHydratedLiveState(current))) {
    return { page: current, stable: true };
  }
  return await stableSnapshot(page, context, attempt);
}

type InitializedLiveSession = {
  page: HltvPageAdapter;
  httpStatus: number | null;
  openedAtMs: number;
  navigatedAtMs: number;
  snapshot: { page: RawLivePage; stable: boolean };
};

export class LiveCaptureSession {
  readonly #browser: HltvBrowserAdapter;
  readonly #refreshIntervalMs: number;
  readonly #now: () => number;
  #initialized: InitializedLiveSession | undefined;
  #captureTail: Promise<void> = Promise.resolve();
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    browser: HltvBrowserAdapter,
    options: { refreshIntervalMs: number; now?: () => number },
  ) {
    this.#browser = browser;
    this.#refreshIntervalMs = options.refreshIntervalMs;
    this.#now = options.now ?? Date.now;
  }

  capture(context: OperationContext, attempt: number): Promise<LiveCaptureAttempt> {
    if (this.#closing) {
      return Promise.reject(new HltvError('live-list session is closed', {
        code: 'CLIENT_CLOSED', operation: 'live-list', stage: 'queued', retryable: false,
      }));
    }
    const operation = this.#captureTail.then(async () => await this.#capture(context, attempt));
    this.#captureTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      await this.#captureTail;
      await this.#discardPage();
    })();
    return this.#closePromise;
  }

  async #capture(context: OperationContext, attempt: number): Promise<LiveCaptureAttempt> {
    const startedAt = new Date().toISOString();
    let page: HltvPageAdapter | undefined;
    const stopPage = (): void => {
      if (page) void this.#discardPage(page);
    };
    try {
      throwIfStopped(context, 'navigating');
      if (this.#initialized?.page.isClosed()) await this.#discardPage(this.#initialized.page);
      const existingPage = this.#initialized?.page;
      const initialized = await this.#initialize(context, attempt);
      page = initialized.page;
      context.signal.addEventListener('abort', stopPage, { once: true });
      const reused = existingPage === page;
      const refreshDue = reused
        && this.#now() - initialized.navigatedAtMs >= this.#refreshIntervalMs;
      let navigated = !reused;
      let snapshot = initialized.snapshot;

      if (refreshDue) {
        emitProgress(context, {
          stage: 'navigating',
          attempt,
          message: 'Refreshing the persistent HLTV matches page',
        });
        const refreshed = await this.#navigate(page, context, attempt);
        initialized.httpStatus = refreshed.httpStatus;
        initialized.navigatedAtMs = this.#now();
        initialized.snapshot = refreshed.snapshot;
        snapshot = refreshed.snapshot;
        navigated = true;
      } else if (reused) {
        emitProgress(context, {
          stage: 'extracting-page',
          attempt,
          message: 'Reading the persistent HLTV matches page',
        });
        snapshot = await currentSnapshot(page, context, attempt);
        initialized.snapshot = snapshot;
      }

      throwIfStopped(context, 'extracting-page');
      validateUrl(snapshot.page.url);
      const completedAt = new Date().toISOString();
      return {
        page: snapshot.page,
        capturedAt: completedAt,
        stable: snapshot.stable,
        httpStatus: initialized.httpStatus,
        attempt,
        startedAt,
        completedAt,
        session: {
          reused,
          navigated,
          ageMs: Math.max(0, this.#now() - initialized.openedAtMs),
        },
      };
    } catch (error) {
      if (page) await this.#discardPage(page);
      throwIfStopped(context, 'extracting-page');
      throw asHltvError(error, {
        code: 'INTERNAL_ERROR', operation: 'live-list', stage: 'extracting-page', retryable: false,
      });
    } finally {
      context.signal.removeEventListener('abort', stopPage);
    }
  }

  async #initialize(
    context: OperationContext,
    attempt: number,
  ): Promise<InitializedLiveSession> {
    if (this.#initialized) return this.#initialized;
    let page: HltvPageAdapter | undefined;
    const stopPage = (): void => { void page?.close().catch(() => undefined); };
    try {
      throwIfStopped(context, 'navigating');
      page = await this.#browser.newPage();
      await page.addInitScript('globalThis.__name = (target) => target');
      context.signal.addEventListener('abort', stopPage, { once: true });
      emitProgress(context, { stage: 'navigating', attempt, message: `Opening ${LIVE_URL}` });
      const navigated = await this.#navigate(page, context, attempt);
      const now = this.#now();
      this.#initialized = {
        page,
        httpStatus: navigated.httpStatus,
        openedAtMs: now,
        navigatedAtMs: now,
        snapshot: navigated.snapshot,
      };
      return this.#initialized;
    } catch (error) {
      await page?.close().catch(() => undefined);
      throw error;
    } finally {
      context.signal.removeEventListener('abort', stopPage);
    }
  }

  async #navigate(
    page: HltvPageAdapter,
    context: OperationContext,
    attempt: number,
  ): Promise<{
      httpStatus: number | null;
      snapshot: { page: RawLivePage; stable: boolean };
    }> {
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
    const httpStatus = response?.status() ?? null;
    classifyHttp(httpStatus);
    validateUrl(page.url());
    emitProgress(context, { stage: 'extracting-page', attempt, message: 'Extracting live match cards' });
    const snapshot = await stableSnapshot(page, context, attempt);
    validateUrl(snapshot.page.url);
    return { httpStatus, snapshot };
  }

  async #discardPage(expected?: HltvPageAdapter): Promise<void> {
    const initialized = this.#initialized;
    if (!initialized || (expected && initialized.page !== expected)) {
      if (expected) await expected.close().catch(() => undefined);
      return;
    }
    this.#initialized = undefined;
    await initialized.page.close().catch(() => undefined);
  }
}

export async function captureLiveMatches(
  browser: HltvBrowserAdapter,
  context: OperationContext,
  attempt: number,
): Promise<LiveCaptureAttempt> {
  const session = new LiveCaptureSession(browser, { refreshIntervalMs: 2 * 60_000 });
  try {
    return await session.capture(context, attempt);
  } finally {
    await session.close();
  }
}
