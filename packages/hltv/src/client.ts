import { launch } from 'cloakbrowser';
import type { Browser } from 'playwright-core';
import { matchIdentityFromUrl, normalizeClientOptions, splitCombinedOptions } from './config.js';
import { HltvError } from './errors.js';
import { getLiveMatchesWithBrowser } from './get_hltv_live_matches.js';
import { getMatchWithBrowser } from './get_hltv_match.js';
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
  operation: 'live-list' | 'match-detail';
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

class HltvClientImpl implements HltvClient {
  readonly #browser: Browser;
  readonly #maxConcurrency: number;
  readonly #minRequestIntervalMs: number;
  readonly #queue: QueueTask[] = [];
  #active = 0;
  #nextStartAt = 0;
  #closing = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #resolveIdle: (() => void) | undefined;

  constructor(browser: Browser, options: ReturnType<typeof normalizeClientOptions>) {
    this.#browser = browser;
    this.#maxConcurrency = options.maxConcurrency;
    this.#minRequestIntervalMs = options.minRequestIntervalMs;
  }

  async getLiveMatches(options?: HltvRequestOptions): Promise<GetHltvLiveMatchesResult> {
    const context = createOperationContext('live-list', options, 60_000);
    return await this.#schedule(context, () => getLiveMatchesWithBrowser(this.#browser, context));
  }

  async getMatch(matchUrl: string, options?: HltvRequestOptions): Promise<GetHltvMatchResult> {
    if (typeof matchUrl !== 'string' || !matchIdentityFromUrl(matchUrl)) {
      throw new HltvError('matchUrl must be a canonical https://www.hltv.org/matches/<id>/<slug> URL', {
        code: 'INVALID_INPUT', operation: 'match-detail', stage: 'validating-input', retryable: false,
      });
    }
    const context = createOperationContext('match-detail', options, 180_000);
    return await this.#schedule(context, () => getMatchWithBrowser(this.#browser, matchUrl, context));
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      const queued = this.#queue.splice(0);
      for (const task of queued) {
        task.context.signal.removeEventListener('abort', task.onAbort);
        task.context.dispose();
        task.reject(new HltvError('client was closed before the operation started', {
          code: 'CLIENT_CLOSED', operation: task.context.operation, stage: 'queued', retryable: false,
        }));
      }
      if (this.#active > 0) {
        await new Promise<void>((resolve) => { this.#resolveIdle = resolve; });
      }
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
      context.dispose();
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
          context.dispose();
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
      task.context.dispose();
      this.#active -= 1;
      if (this.#closing && this.#active === 0) this.#resolveIdle?.();
      else this.#drain();
    }
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
  return new HltvClientImpl(browser, normalized);
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
