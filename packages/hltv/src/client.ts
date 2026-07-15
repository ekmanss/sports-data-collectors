import { launch } from 'cloakbrowser';
import type { Browser } from 'playwright-core';
import type { HltvBrowserAdapter } from './browser_adapter.js';
import { LiveCaptureSession } from './capture/capture_live.js';
import { matchIdentityFromUrl, normalizeClientOptions, splitCombinedOptions } from './config.js';
import { HltvError } from './errors.js';
import { getCompletedMatchStatsWithBrowser } from './get_hltv_completed_match_stats.js';
import { getLiveMatchesWithSession } from './get_hltv_live_matches.js';
import {
  createMatchCaptureSession,
  getMatchWithSession,
} from './get_hltv_match.js';
import {
  abortableDelay,
  createOperationContext,
  emitProgress,
  remainingMs,
  retryDelayMilliseconds,
  throwIfStopped,
  type OperationContext,
} from './runtime.js';
import type {
  GetHltvLiveMatchesOptions,
  GetHltvLiveMatchesResult,
  GetHltvCompletedMatchStatsOptions,
  GetHltvCompletedMatchStatsResult,
  GetHltvMatchOptions,
  GetHltvMatchResult,
  HltvClient,
  HltvClientOptions,
  HltvRequestOptions,
} from './types.js';

type OneShotResult = {
  diagnostics: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
    attempts: Array<{
      attempt: number;
      startedAt: string;
      completedAt: string;
      httpStatus: number | null;
      error?: { code: string; message: string };
    }>;
  };
};

async function runOneShot<T extends OneShotResult>(input: {
  clientOptions: HltvClientOptions;
  requestOptions: HltvRequestOptions;
  operation: 'live-list' | 'match-detail' | 'completed-match-stats';
  defaultTimeoutMs: number;
  execute(client: HltvClient, request: HltvRequestOptions): Promise<T>;
}): Promise<T> {
  const context = createOperationContext(
    input.operation,
    input.requestOptions,
    input.defaultTimeoutMs,
  );
  const startedAt = new Date().toISOString();
  const failedAttempts: OneShotResult['diagnostics']['attempts'] = [];
  try {
    for (let browserAttempt = 1; browserAttempt <= 3; browserAttempt += 1) {
      throwIfStopped(context, 'launching-browser');
      const attemptStartedAt = new Date().toISOString();
      const client = await createHltvClient(input.clientOptions);
      try {
        const result = await input.execute(client, {
          ...input.requestOptions,
          timeoutMs: remainingMs(context),
          signal: context.signal,
        });
        const attempts = [
          ...failedAttempts,
          ...result.diagnostics.attempts,
        ].map((attempt, index) => ({ ...attempt, attempt: index + 1 }));
        return {
          ...result,
          diagnostics: {
            ...result.diagnostics,
            startedAt,
            durationMs: Math.max(
              0,
              Date.parse(result.diagnostics.completedAt) - Date.parse(startedAt),
            ),
            attempts,
          },
        };
      } catch (error) {
        const normalized = error instanceof HltvError ? error : null;
        if (normalized?.code !== 'ACCESS_BLOCKED' || browserAttempt === 3) throw error;
        failedAttempts.push({
          attempt: browserAttempt,
          startedAt: attemptStartedAt,
          completedAt: new Date().toISOString(),
          httpStatus: typeof normalized.details?.httpStatus === 'number'
            ? normalized.details.httpStatus
            : null,
          error: { code: normalized.code, message: normalized.message },
        });
        emitProgress(context, {
          stage: 'navigating',
          attempt: browserAttempt,
          message: `Access challenge; rotating browser before retry ${browserAttempt} of 2`,
        });
      } finally {
        await client.close();
      }
      await abortableDelay(
        retryDelayMilliseconds('ACCESS_BLOCKED', browserAttempt),
        context,
        'navigating',
      );
    }
    throw new HltvError('one-shot capture produced no result', {
      code: 'INTERNAL_ERROR',
      operation: input.operation,
      stage: 'extracting-page',
      retryable: false,
    });
  } finally {
    context.dispose();
  }
}

interface QueueTask<T = unknown> {
  context: OperationContext;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

type MatchSessionEntry = {
  session: ReturnType<typeof createMatchCaptureSession>;
  lastUsedAt: number;
  activeCaptures: number;
};

export function selectMatchSessionEvictions(
  entries: ReadonlyArray<{
    matchId: number;
    lastUsedAt: number;
    activeCaptures: number;
  }>,
  options: {
    now: number;
    idleTimeoutMs: number;
    maxSessions: number;
    reserve: number;
  },
): number[] {
  const inactive = entries
    .filter((entry) => entry.activeCaptures === 0)
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  const selected = inactive
    .filter((entry) => options.now - entry.lastUsedAt >= options.idleTimeoutMs)
    .map((entry) => entry.matchId);
  const selectedIds = new Set(selected);
  const remainingCount = entries.length - selected.length;
  const capacityEvictions = Math.max(
    0,
    remainingCount + options.reserve - options.maxSessions,
  );
  for (const entry of inactive) {
    if (selectedIds.has(entry.matchId)) continue;
    if (selected.length >= capacityEvictions + selectedIds.size) break;
    selected.push(entry.matchId);
  }
  return selected;
}

class HltvClientImpl implements HltvClient {
  readonly #browser: HltvBrowserAdapter;
  readonly #liveSession: LiveCaptureSession;
  readonly #maxConcurrency: number;
  readonly #minRequestIntervalMs: number;
  readonly #matchSessionIdleTimeoutMs: number;
  readonly #maxMatchSessions: number;
  readonly #queue: QueueTask[] = [];
  readonly #matchSessions = new Map<number, MatchSessionEntry>();
  #active = 0;
  #nextStartAt = 0;
  #closing = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #resolveIdle: (() => void) | undefined;

  constructor(browser: HltvBrowserAdapter, options: ReturnType<typeof normalizeClientOptions>) {
    this.#browser = browser;
    this.#liveSession = new LiveCaptureSession(browser, {
      refreshIntervalMs: options.livePageRefreshIntervalMs,
    });
    this.#maxConcurrency = options.maxConcurrency;
    this.#minRequestIntervalMs = options.minRequestIntervalMs;
    this.#matchSessionIdleTimeoutMs = options.matchSessionIdleTimeoutMs;
    this.#maxMatchSessions = options.maxMatchSessions;
  }

  async getLiveMatches(options?: HltvRequestOptions): Promise<GetHltvLiveMatchesResult> {
    const context = createOperationContext('live-list', options, 60_000);
    try {
      await this.#evictMatchSessions();
      return await this.#schedule(context, () => getLiveMatchesWithSession(this.#liveSession, context));
    } finally {
      context.dispose();
    }
  }

  async getMatch(matchUrl: string, options?: HltvRequestOptions): Promise<GetHltvMatchResult> {
    if (typeof matchUrl !== 'string' || !matchIdentityFromUrl(matchUrl)) {
      throw new HltvError('matchUrl must be a canonical https://www.hltv.org/matches/<id>/<slug> URL', {
        code: 'INVALID_INPUT', operation: 'match-detail', stage: 'validating-input', retryable: false,
      });
    }
    const identity = matchIdentityFromUrl(matchUrl)!;
    const context = createOperationContext('match-detail', options, 180_000);
    try {
      await this.#evictMatchSessions();
      emitProgress(context, { stage: 'validating-input', attempt: 1, message: 'Validated HLTV match URL' });
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const existing = this.#matchSessions.get(identity.id);
          if (existing) {
            return await this.#captureMatch(existing, matchUrl, context, attempt);
          }
          return await this.#schedule(context, async () => {
            let entry = this.#matchSessions.get(identity.id);
            if (!entry) {
              await this.#evictMatchSessions(1);
              entry = {
                session: createMatchCaptureSession(this.#browser, matchUrl),
                lastUsedAt: Date.now(),
                activeCaptures: 0,
              };
              this.#matchSessions.set(identity.id, entry);
            }
            return await this.#captureMatch(entry, matchUrl, context, attempt);
          });
        } catch (error) {
          const entry = this.#matchSessions.get(identity.id);
          if (entry) {
            this.#matchSessions.delete(identity.id);
            await entry.session.close();
          }
          const normalized = error instanceof HltvError ? error : null;
          if (!normalized?.retryable || normalized.code === 'ACCESS_BLOCKED' || attempt === 2) {
            throw error;
          }
          emitProgress(context, {
            stage: 'navigating',
            attempt,
            message: 'Persistent match session failed; opening a fresh session once',
          });
          await abortableDelay(
            retryDelayMilliseconds(normalized.code, attempt),
            context,
            'navigating',
            identity.id,
          );
        }
      }
      throw new HltvError('match capture produced no result', {
        code: 'INTERNAL_ERROR', operation: 'match-detail', stage: 'extracting-page', retryable: false,
        matchId: identity.id,
      });
    } finally {
      context.dispose();
    }
  }

  async getCompletedMatchStats(
    matchUrl: string,
    options?: HltvRequestOptions,
  ): Promise<GetHltvCompletedMatchStatsResult> {
    if (typeof matchUrl !== 'string' || !matchIdentityFromUrl(matchUrl)) {
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
    const context = createOperationContext('completed-match-stats', options, 60_000);
    try {
      await this.#evictMatchSessions();
      return await this.#schedule(context, () =>
        getCompletedMatchStatsWithBrowser(this.#browser, matchUrl, context));
    } finally {
      context.dispose();
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      const queued = this.#queue.splice(0);
      for (const task of queued) {
        task.context.signal.removeEventListener('abort', task.onAbort);
        task.reject(new HltvError('client was closed before the operation started', {
          code: 'CLIENT_CLOSED', operation: task.context.operation, stage: 'queued', retryable: false,
        }));
      }
      if (this.#active > 0) {
        await new Promise<void>((resolve) => { this.#resolveIdle = resolve; });
      }
      const sessions = [...this.#matchSessions.values()];
      this.#matchSessions.clear();
      await Promise.all([
        this.#liveSession.close(),
        ...sessions.map(async ({ session }) => await session.close()),
      ]);
      await this.#browser.close();
      this.#closed = true;
    })();
    return this.#closePromise;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #schedule<T>(context: OperationContext, run: () => Promise<T>): Promise<T> {
    if (this.#closing || this.#closed) {
      throw new HltvError('client is closed', {
        code: 'CLIENT_CLOSED', operation: context.operation, stage: 'queued', retryable: false,
      });
    }
    emitProgress(context, { stage: 'queued', attempt: 1, message: 'Operation queued' });
    return new Promise<T>((resolve, reject) => {
      const task: QueueTask<T> = {
        context,
        run,
        resolve,
        reject,
        onAbort: () => {
          const index = this.#queue.indexOf(task as QueueTask);
          if (index < 0) return;
          this.#queue.splice(index, 1);
          try {
            throwIfStopped(context, 'queued');
          } catch (error) {
            reject(error);
          }
        },
      };
      context.signal.addEventListener('abort', task.onAbort, { once: true });
      this.#queue.push(task as QueueTask);
      this.#drain();
    });
  }

  #drain(): void {
    while (!this.#closing && this.#active < this.#maxConcurrency && this.#queue.length > 0) {
      const task = this.#queue.shift()!;
      task.context.signal.removeEventListener('abort', task.onAbort);
      this.#active += 1;
      void this.#runTask(task);
    }
  }

  async #runTask(task: QueueTask): Promise<void> {
    try {
      throwIfStopped(task.context, 'queued');
      const now = Date.now();
      const startAt = Math.max(now, this.#nextStartAt);
      this.#nextStartAt = startAt + this.#minRequestIntervalMs;
      if (startAt > now) {
        emitProgress(task.context, { stage: 'throttling', attempt: 1, message: 'Waiting for the request interval' });
        await abortableDelay(startAt - now, task.context, 'throttling');
      }
      task.resolve(await task.run());
    } catch (error) {
      task.reject(error);
    } finally {
      this.#active -= 1;
      if (this.#closing && this.#active === 0) this.#resolveIdle?.();
      else this.#drain();
    }
  }

  async #captureMatch(
    entry: MatchSessionEntry,
    matchUrl: string,
    context: OperationContext,
    attempt: number,
  ): Promise<GetHltvMatchResult> {
    entry.activeCaptures += 1;
    entry.lastUsedAt = Date.now();
    try {
      return await getMatchWithSession(entry.session, matchUrl, context, attempt);
    } finally {
      entry.activeCaptures -= 1;
      entry.lastUsedAt = Date.now();
    }
  }

  async #evictMatchSessions(reserve = 0): Promise<void> {
    const ids = selectMatchSessionEvictions(
      [...this.#matchSessions].map(([matchId, entry]) => ({
        matchId,
        lastUsedAt: entry.lastUsedAt,
        activeCaptures: entry.activeCaptures,
      })),
      {
        now: Date.now(),
        idleTimeoutMs: this.#matchSessionIdleTimeoutMs,
        maxSessions: this.#maxMatchSessions,
        reserve,
      },
    );
    const closes = ids.flatMap((matchId) => {
      const entry = this.#matchSessions.get(matchId);
      if (!entry) return [];
      this.#matchSessions.delete(matchId);
      return [entry.session.close().catch(() => undefined)];
    });
    await Promise.all(closes);
  }
}

export async function createHltvClient(options: HltvClientOptions = {}): Promise<HltvClient> {
  const normalized = normalizeClientOptions(options);
  let browser: Browser;
  try {
    browser = await launch({
      headless: normalized.headless,
      locale: 'en-US',
      timezone: normalized.timezone,
      ...(normalized.proxy ? { proxy: normalized.proxy } : {}),
    });
  } catch (cause) {
    throw new HltvError('failed to launch CloakBrowser', {
      code: 'BROWSER_LAUNCH_FAILED', operation: 'client', stage: 'launching-browser', retryable: true, cause,
    });
  }
  return new HltvClientImpl(browser as unknown as HltvBrowserAdapter, normalized);
}

export function createHltvClientWithBrowser(
  browser: HltvBrowserAdapter,
  options: HltvClientOptions = {},
): HltvClient {
  if (!browser || typeof browser.newPage !== 'function' || typeof browser.close !== 'function') {
    throw new HltvError('browser adapter must implement newPage() and close()', {
      code: 'INVALID_INPUT', operation: 'client', stage: 'validating-input', retryable: false,
    });
  }
  return new HltvClientImpl(browser, normalizeClientOptions(options));
}

export async function getHltvLiveMatches(
  options: GetHltvLiveMatchesOptions = {},
): Promise<GetHltvLiveMatchesResult> {
  const split = splitCombinedOptions(options);
  return await runOneShot({
    clientOptions: split.client,
    requestOptions: split.request as HltvRequestOptions,
    operation: 'live-list',
    defaultTimeoutMs: 60_000,
    execute: (client, request) => client.getLiveMatches(request),
  });
}

export async function getHltvMatch(
  matchUrl: string,
  options: GetHltvMatchOptions = {},
): Promise<GetHltvMatchResult> {
  if (typeof matchUrl !== 'string' || !matchIdentityFromUrl(matchUrl)) {
    throw new HltvError('matchUrl must be a canonical https://www.hltv.org/matches/<id>/<slug> URL', {
      code: 'INVALID_INPUT', operation: 'match-detail', stage: 'validating-input', retryable: false,
    });
  }
  const split = splitCombinedOptions(options);
  return await runOneShot({
    clientOptions: split.client,
    requestOptions: split.request as HltvRequestOptions,
    operation: 'match-detail',
    defaultTimeoutMs: 180_000,
    execute: (client, request) => client.getMatch(matchUrl, request),
  });
}

export async function getHltvCompletedMatchStats(
  matchUrl: string,
  options: GetHltvCompletedMatchStatsOptions = {},
): Promise<GetHltvCompletedMatchStatsResult> {
  if (typeof matchUrl !== 'string' || !matchIdentityFromUrl(matchUrl)) {
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
  const split = splitCombinedOptions(options);
  return await runOneShot({
    clientOptions: split.client,
    requestOptions: split.request as HltvRequestOptions,
    operation: 'completed-match-stats',
    defaultTimeoutMs: 60_000,
    execute: (client, request) => client.getCompletedMatchStats(matchUrl, request),
  });
}
