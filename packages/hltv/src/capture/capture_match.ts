import type { Browser, Page } from 'playwright-core';
import { matchIdentityFromUrl, type MatchIdentity } from '../config.js';
import { HltvError, asHltvError } from '../errors.js';
import { extractHltvMatchPage } from '../extractors/match_page.js';
import { collectorVersions } from '../metadata.js';
import {
  abortableDelay,
  emitProgress,
  navigationTimeout,
  throwIfStopped,
  type OperationContext,
} from '../runtime.js';
import type {
  CaptureAttempt,
  MatchCaptureTimings,
  RawExtractedPage,
  RawLogEvent,
  RawScoreboard,
  RawSnapshot,
} from '../types.js';

export interface MatchCaptureOptions extends MatchIdentity {
  context: OperationContext;
  pageReadyTimeoutMs: number;
  scorebotReadyTimeoutMs: number;
}

const STABILITY_POLL_MS = 250;
const SCOREBOT_POLL_MS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExtractedPage(value: unknown): asserts value is RawExtractedPage {
  if (!isRecord(value) || !isRecord(value.match) || !Array.isArray(value.teams) || !isRecord(value.maps) || !Array.isArray(value.lineups)) {
    throw new HltvError('HLTV page returned an unrecognized match payload', {
      code: 'INCOMPLETE_CAPTURE', operation: 'match-detail', stage: 'extracting-page', retryable: false,
    });
  }
  if (typeof value.url !== 'string' || typeof value.title !== 'string' || !isRecord(value.sections)) {
    throw new HltvError('HLTV page metadata is incomplete', {
      code: 'INCOMPLETE_CAPTURE', operation: 'match-detail', stage: 'extracting-page', retryable: false,
    });
  }
}

function validateFinalUrl(finalUrl: string, options: MatchCaptureOptions): void {
  const identity = matchIdentityFromUrl(finalUrl);
  if (!identity || identity.id !== options.id) {
    throw new HltvError('HLTV returned a different or invalid match URL', {
      code: 'INCOMPLETE_CAPTURE', stage: 'validating-source', retryable: false,
      operation: 'match-detail', matchId: options.id, details: { finalUrl },
    });
  }
}

async function evaluatePage(page: Page): Promise<RawExtractedPage> {
  await page.evaluate('globalThis.__name = (target) => target');
  const extracted: unknown = await page.evaluate(`(${extractHltvMatchPage.toString()})()`);
  assertExtractedPage(extracted);
  return extracted;
}

function matchPageSignature(page: RawExtractedPage): string {
  return JSON.stringify({
    match: page.match,
    teams: page.teams.map((team) => [team.id, team.name]),
    maps: page.maps.maps.map((map) => [
      map.name,
      map.teams.map((team) => [team.name, team.score]),
    ]),
    lineups: page.lineups.map((lineup) => [
      lineup.id,
      lineup.players.map((player) => player.id),
    ]),
    matchStatsViews: page.matchStats?.views.length ?? 0,
    sections: page.sections,
  });
}

async function waitForStableMatchPage(
  page: Page,
  options: MatchCaptureOptions,
): Promise<RawExtractedPage> {
  const started = performance.now();
  let previousSignature: string | null = null;
  let latest: RawExtractedPage | null = null;
  let lastError: unknown;
  while (performance.now() - started < options.pageReadyTimeoutMs) {
    throwIfStopped(options.context, 'extracting-page', options.id);
    try {
      latest = await evaluatePage(page);
      if (latest.sections.matchPage && latest.match.id === options.id) {
        const signature = matchPageSignature(latest);
        if (signature === previousSignature) return latest;
        previousSignature = signature;
      }
    } catch (error) {
      lastError = error;
    }
    await abortableDelay(STABILITY_POLL_MS, options.context, 'extracting-page', options.id);
  }
  if (latest?.sections.matchPage && latest.match.id === options.id) return latest;
  if (lastError) throw lastError;
  return await evaluatePage(page);
}

async function extractScoreboard(page: Page): Promise<RawScoreboard | null> {
  const value: unknown = await page.evaluate(`(() => {
    const root = document.querySelector('#scoreboardElement .scoreboard');
    if (!root) return null;
    const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const teams = [...root.querySelectorAll('table.team')].map((table) => {
      const rows = [...table.querySelectorAll('tr')];
      return {
        team: clean(rows[0]?.querySelector('.identityColumns')?.textContent),
        players: rows.slice(1).map((row) => ({
          player: clean(row.querySelector('.identityColumns')?.textContent),
          cells: [...row.querySelectorAll('td,th')].map((cell) => ({
            className: cell.className,
            text: clean(cell.textContent),
            images: [...cell.querySelectorAll('img')].map((image) => ({
              src: image.getAttribute('src'), alt: image.getAttribute('alt'), title: image.getAttribute('title'),
            })),
          })),
        })),
      };
    });
    return {
      mode: clean(root.querySelector('.pro-toggle.active')?.textContent),
      round: clean(root.querySelector('.currentRoundText')?.textContent),
      fact: clean(root.querySelector('.facts')?.textContent),
      score: clean(root.querySelector('.scoreText')?.textContent),
      teams,
    };
  })()`);
  return value as RawScoreboard | null;
}

async function switchScoreboard(page: Page, label: 'Normal' | 'Advanced'): Promise<boolean> {
  const toggle = page.locator('#scoreboardElement .pro-toggle').filter({ hasText: label });
  if (await toggle.count() !== 1) return false;
  await toggle.click();
  await page.waitForTimeout(250);
  return true;
}

async function extractFullGameLog(page: Page): Promise<{
  scrollHeight: number;
  chronological: RawLogEvent[];
  positionsVisited: number;
}> {
  const result = await page.evaluate(async () => {
    const list = document.querySelector<HTMLElement>('#scoreboardElement .gamelog .list.desktop');
    if (!list) return { scrollHeight: 0, chronological: [], positionsVisited: 0 };

    const clean = (value: string | null | undefined): string =>
      (value || '').replace(/\s+/g, ' ').trim();
    const step = Math.max(list.clientHeight - 104, 156);
    const positions = [...new Set([
      ...Array.from(
        { length: Math.ceil(list.scrollHeight / step) + 1 },
        (_, index) => index * step,
      ),
      list.scrollHeight,
    ])];
    const byTop = new Map<number, RawLogEvent>();
    const waitForRender = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    };

    for (const position of positions) {
      list.scrollTop = position;
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForRender();
      const rows = Array.from(list.querySelectorAll('.topPadding')) as HTMLElement[];
      for (const row of rows) {
        const box = row.querySelector('.gamelogBox') as HTMLElement | null;
        if (!box) continue;
        const tokens: string[] = [];
        const visit = (node: Node): void => {
          if (node.nodeType === Node.TEXT_NODE) {
            const value = clean(node.textContent);
            if (value) tokens.push(value);
          } else if (node instanceof HTMLImageElement) {
            const alt = clean(node.alt);
            if (alt) tokens.push(alt);
          } else {
            node.childNodes.forEach(visit);
          }
        };
        visit(box);
        const top = Number.parseInt(row.style.top || '0', 10);
        byTop.set(top, {
          top,
          type: Array.from(box.classList).filter((name) => name !== 'gamelogBox'),
          text: clean(tokens.join(' '))
            .replace(/\s+([),])/g, '$1')
            .replace(/([(])\s+/g, '$1'),
          players: (Array.from(box.querySelectorAll('.ctplayer,.tplayer')) as HTMLElement[]).map((player) => ({
            name: clean(player.textContent),
            side: player.classList.contains('ctplayer') ? 'CT' as const : 'T' as const,
          })),
          weapon: (box.querySelector('.playerWeapon') as HTMLImageElement | null)?.src
            .split('/').pop()?.replace('.png', '') || null,
          headshot: Boolean(box.querySelector('.headshotIcon')),
        });
      }
    }
    return {
      scrollHeight: list.scrollHeight,
      chronological: [...byTop.values()].sort((left, right) => right.top - left.top),
      positionsVisited: positions.length,
    };
  });
  return result as {
    scrollHeight: number;
    chronological: RawLogEvent[];
    positionsVisited: number;
  };
}

function formalGameLog(events: RawLogEvent[]): RawLogEvent[] {
  const formal: RawLogEvent[] = [];
  let inRound = false;
  for (const event of events) {
    if (event.text === 'Round started') inRound = true;
    if (!inRound) continue;
    formal.push(event);
    if (event.text.startsWith('Round over')) inRound = false;
  }
  return formal;
}

async function collectSnapshot(
  page: Page,
  httpStatus: number | null,
  timings: MatchCaptureTimings,
  scorebotUsable: boolean,
): Promise<RawSnapshot> {
  const pageStarted = performance.now();
  const pageData = await evaluatePage(page);
  timings.snapshotPageMs = Math.round(performance.now() - pageStarted);
  if (!scorebotUsable) {
    return {
      capturedAt: new Date().toISOString(), httpStatus, page: pageData,
      scoreboardNormal: null, scoreboardAdvanced: null,
      gameLog: {
        scrollHeight: 0,
        chronological: [],
        excludedNoiseEvents: 0,
        positionsVisited: 0,
      },
      note: 'Scorebot was not semantically usable for this match state.',
    };
  }
  const scoreboardsStarted = performance.now();
  const normal = await extractScoreboard(page);
  let advanced: RawScoreboard | null = null;
  if (await switchScoreboard(page, 'Advanced')) {
    advanced = await extractScoreboard(page);
    await switchScoreboard(page, 'Normal');
  }
  timings.scoreboardsMs = Math.round(performance.now() - scoreboardsStarted);
  const gameLogStarted = performance.now();
  const rawLog = await extractFullGameLog(page);
  timings.gameLogMs = Math.round(performance.now() - gameLogStarted);
  if (!isExtractedScorebotUsable(normal, rawLog)) {
    return {
      capturedAt: new Date().toISOString(), httpStatus, page: pageData,
      scoreboardNormal: null, scoreboardAdvanced: null,
      gameLog: {
        scrollHeight: 0,
        chronological: [],
        excludedNoiseEvents: 0,
        positionsVisited: rawLog.positionsVisited,
      },
      note: 'Scorebot became incomplete while the snapshot was being extracted.',
    };
  }
  const chronological = formalGameLog(rawLog.chronological);
  return {
    capturedAt: new Date().toISOString(), httpStatus, page: pageData,
    scoreboardNormal: normal, scoreboardAdvanced: advanced,
    gameLog: {
      scrollHeight: rawLog.scrollHeight,
      chronological,
      excludedNoiseEvents: rawLog.chronological.length - chronological.length,
      positionsVisited: rawLog.positionsVisited,
    },
    note: normal ? null : 'Scorebot was not present for this match state.',
  };
}

type ScorebotState = {
  present: boolean;
  ready: boolean;
  signature: string;
  score: string;
  round: string;
  teamNames: string[];
  playerRows: number;
  scrollHeight: number;
  visibleLogRows: number;
};

export type ScorebotReadinessProbe = Omit<ScorebotState, 'ready' | 'signature'>;

export function isScorebotSemanticallyReady(probe: ScorebotReadinessProbe): boolean {
  if (!probe.present || !/^\d+\s*:\s*\d+$/.test(probe.score)) return false;
  const roundMatch = probe.round.match(/^(\d+)\s*-\s*(.+)$/);
  if (!roundMatch) return false;
  const map = roundMatch[2]!.trim().toLowerCase();
  if (!map || map === 'unknown' || map === 'tbd' || map === '-') return false;
  if (probe.teamNames.length !== 2 || probe.teamNames.some((name) => !name)) return false;
  if (probe.playerRows < 8) return false;
  const scoreTotal = probe.score.split(/\D+/).reduce(
    (sum, value) => sum + (Number(value) || 0),
    0,
  );
  const needsGameLog = scoreTotal > 0 || Number(roundMatch[1]) > 1;
  return !needsGameLog || (probe.scrollHeight > 0 && probe.visibleLogRows > 0);
}

function isExtractedScorebotUsable(
  scoreboard: RawScoreboard | null,
  log: { scrollHeight: number; chronological: RawLogEvent[] },
): boolean {
  if (!scoreboard) return false;
  return isScorebotSemanticallyReady({
    present: true,
    score: scoreboard.score,
    round: scoreboard.round,
    teamNames: scoreboard.teams.map((team) => team.team),
    playerRows: scoreboard.teams.reduce((sum, team) => sum + team.players.length, 0),
    scrollHeight: log.scrollHeight,
    visibleLogRows: log.chronological.length,
  });
}

async function scorebotState(page: Page): Promise<ScorebotState> {
  const probe = await page.evaluate(() => {
    const root = document.querySelector('#scoreboardElement .scoreboard');
    const list = document.querySelector<HTMLElement>('#scoreboardElement .gamelog .list.desktop');
    const clean = (value: string | null | undefined): string =>
      (value || '').replace(/\s+/g, ' ').trim();
    if (!root) {
      return {
        present: false,
        score: '',
        round: '',
        teamNames: [],
        playerRows: 0,
        scrollHeight: 0,
        visibleLogRows: 0,
        signature: '',
      };
    }
    const score = clean(root.querySelector('.scoreText')?.textContent);
    const round = clean(root.querySelector('.currentRoundText')?.textContent);
    const tables = Array.from(root.querySelectorAll('table.team'));
    const teamNames = tables.map((table) =>
      clean(table.querySelector('tr .identityColumns')?.textContent));
    const playerRows = tables.reduce(
      (sum, table) => sum + Math.max(0, table.querySelectorAll('tr').length - 1),
      0,
    );
    const visibleLogRows = list?.querySelectorAll('.topPadding').length ?? 0;
    const scrollHeight = list?.scrollHeight ?? 0;
    const dynamicText = clean(root.textContent);
    const staticText = Array.from(document.querySelectorAll('.mapholder,.timeAndEvent'))
      .map((element) => clean(element.textContent))
      .join('|');
    return {
      present: true,
      score,
      round,
      teamNames,
      playerRows,
      scrollHeight,
      visibleLogRows,
      signature: JSON.stringify({
        dynamicText,
        staticText,
        scrollHeight,
      }),
    };
  });
  return {
    ...probe,
    ready: isScorebotSemanticallyReady(probe),
  };
}

async function waitForStableScorebot(
  page: Page,
  options: MatchCaptureOptions,
): Promise<ScorebotState> {
  const started = performance.now();
  let latest: ScorebotState = {
    present: false,
    ready: false,
    signature: '',
    score: '',
    round: '',
    teamNames: [],
    playerRows: 0,
    scrollHeight: 0,
    visibleLogRows: 0,
  };
  while (performance.now() - started < options.scorebotReadyTimeoutMs) {
    throwIfStopped(options.context, 'extracting-scorebot', options.id);
    latest = await scorebotState(page);
    if (latest.ready) return latest;
    await abortableDelay(
      SCOREBOT_POLL_MS,
      options.context,
      'extracting-scorebot',
      options.id,
    );
  }
  return latest;
}

function classifyHttp(status: number | null): void {
  if (status === 404) {
    throw new HltvError('HLTV match page was not found', { code: 'MATCH_NOT_FOUND', operation: 'match-detail', stage: 'navigating', retryable: false });
  }
  if (status === 403) {
    throw new HltvError('HLTV denied access to the match page', {
      code: 'ACCESS_BLOCKED', operation: 'match-detail', stage: 'navigating', retryable: true,
      details: { httpStatus: status },
    });
  }
  if (status === 429 || (status !== null && status >= 500)) {
    throw new HltvError(`HLTV returned HTTP ${status}`, { code: 'NAVIGATION_FAILED', operation: 'match-detail', stage: 'navigating', retryable: true, details: { httpStatus: status } });
  }
}

export async function captureMatch(
  browser: Browser,
  options: MatchCaptureOptions,
  attempt: number,
): Promise<CaptureAttempt> {
  const session = new MatchCaptureSession(browser, options);
  let capture: CaptureAttempt | undefined;
  try {
    capture = await session.capture(options.context, attempt);
    return capture;
  } finally {
    const pageCloseStarted = performance.now();
    await session.close();
    if (capture?.timings) {
      capture.timings.pageCloseMs = Math.round(performance.now() - pageCloseStarted);
    }
  }
}

type InitializedMatchSession = {
  page: Page;
  initialPage: RawExtractedPage;
  versions: Awaited<ReturnType<typeof collectorVersions>>;
  httpStatus: number | null;
  timings: MatchCaptureTimings;
  openedAtMs: number;
};

function emptyTimings(): MatchCaptureTimings {
  return {
    metadataMs: 0,
    newPageMs: 0,
    navigationMs: 0,
    pageReadyMs: 0,
    scorebotReloadMs: 0,
    scorebotReadyMs: 0,
    snapshotPageMs: 0,
    scoreboardsMs: 0,
    gameLogMs: 0,
    pageCloseMs: 0,
  };
}

export class MatchCaptureSession {
  readonly #browser: Browser;
  readonly #identity: MatchIdentity;
  readonly #pageReadyTimeoutMs: number;
  readonly #scorebotReadyTimeoutMs: number;
  #initialized: InitializedMatchSession | undefined;
  #captureTail: Promise<void> = Promise.resolve();
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #successfulCaptures = 0;
  #lastCapture: CaptureAttempt | undefined;
  #lastScorebotSignature: string | undefined;

  constructor(
    browser: Browser,
    options: Pick<MatchCaptureOptions, 'id' | 'slug' | 'url' | 'pageReadyTimeoutMs' | 'scorebotReadyTimeoutMs'>,
  ) {
    this.#browser = browser;
    this.#identity = { id: options.id, slug: options.slug, url: options.url };
    this.#pageReadyTimeoutMs = options.pageReadyTimeoutMs;
    this.#scorebotReadyTimeoutMs = options.scorebotReadyTimeoutMs;
  }

  get id(): number {
    return this.#identity.id;
  }

  get url(): string {
    return this.#identity.url;
  }

  capture(context: OperationContext, attempt: number): Promise<CaptureAttempt> {
    if (this.#closing) {
      return Promise.reject(new HltvError('match session is closed', {
        code: 'CLIENT_CLOSED', operation: 'match-detail', stage: 'queued', retryable: false,
        matchId: this.id,
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
      await this.#initialized?.page.close().catch(() => undefined);
    })();
    return this.#closePromise;
  }

  async #capture(context: OperationContext, attempt: number): Promise<CaptureAttempt> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    try {
      throwIfStopped(context, 'navigating', this.id);
      const initialized = await this.#initialize(context, attempt);
      if (initialized.page.isClosed()) {
        throw new HltvError('the persistent HLTV match page was closed', {
          code: 'NAVIGATION_FAILED', operation: 'match-detail', stage: 'extracting-page', retryable: true,
          matchId: this.id,
        });
      }
      const reused = this.#successfulCaptures > 0;
      const timings = reused ? emptyTimings() : { ...initialized.timings };
      const options: MatchCaptureOptions = {
        ...this.#identity,
        context,
        pageReadyTimeoutMs: this.#pageReadyTimeoutMs,
        scorebotReadyTimeoutMs: reused
          ? Math.min(this.#scorebotReadyTimeoutMs, 6_000)
          : this.#scorebotReadyTimeoutMs,
      };
      emitProgress(context, {
        stage: 'extracting-scorebot',
        attempt,
        message: reused
          ? 'Reading the persistent Scorebot session'
          : 'Extracting Normal/Advanced scoreboard and Game log',
      });
      const status = initialized.initialPage.match.status.toLowerCase();
      const requiresScorebot = status.includes('live') || status.includes('over');
      let state = await scorebotState(initialized.page);
      if (requiresScorebot && !state.ready) {
        const scorebotReadyStarted = performance.now();
        state = await waitForStableScorebot(initialized.page, options);
        timings.scorebotReadyMs = Math.round(performance.now() - scorebotReadyStarted);
      }

      if (state.ready && this.#lastCapture && state.signature === this.#lastScorebotSignature) {
        const completedAt = new Date().toISOString();
        const capture: CaptureAttempt = {
          ...this.#lastCapture,
          snapshot: { ...this.#lastCapture.snapshot, capturedAt: completedAt },
          navigationSeconds: 0,
          totalSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
          timings,
          attempt,
          startedAt,
          completedAt,
          session: {
            reused: true,
            snapshotCacheHit: true,
            ageMs: Date.now() - initialized.openedAtMs,
          },
        };
        this.#lastCapture = capture;
        this.#successfulCaptures += 1;
        return capture;
      }

      const snapshot = await collectSnapshot(
        initialized.page,
        initialized.httpStatus,
        timings,
        state.ready,
      );
      validateFinalUrl(snapshot.page.url, options);
      if (snapshot.page.match.id !== this.id) {
        throw new HltvError('the final page snapshot contains a different match ID', {
          code: 'INCOMPLETE_CAPTURE', operation: 'match-detail', stage: 'validating-source', retryable: false,
          matchId: this.id, details: { pageId: snapshot.page.match.id },
        });
      }
      let finalState: ScorebotState | undefined;
      if (snapshot.scoreboardNormal) {
        finalState = await scorebotState(initialized.page);
      }
      const completedAt = new Date().toISOString();
      const capture: CaptureAttempt = {
        initialPage: initialized.initialPage,
        snapshot,
        collector: initialized.versions,
        httpStatus: initialized.httpStatus,
        navigationSeconds: reused ? 0 : Number((timings.navigationMs / 1000).toFixed(3)),
        totalSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
        timings,
        attempt,
        startedAt,
        completedAt,
        session: {
          reused,
          snapshotCacheHit: false,
          ageMs: Date.now() - initialized.openedAtMs,
        },
      };
      this.#lastCapture = capture;
      this.#lastScorebotSignature = finalState?.ready && finalState.signature === state.signature
        ? finalState.signature
        : undefined;
      this.#successfulCaptures += 1;
      return capture;
    } catch (error) {
      throwIfStopped(context, 'extracting-page', this.id);
      throw asHltvError(error, {
        code: 'INTERNAL_ERROR', operation: 'match-detail', stage: 'extracting-page', retryable: false,
        matchId: this.id,
      });
    }
  }

  async #initialize(context: OperationContext, attempt: number): Promise<InitializedMatchSession> {
    if (this.#initialized) return this.#initialized;
    const timings = emptyTimings();
    const metadataStarted = performance.now();
    const versions = await collectorVersions();
    timings.metadataMs = Math.round(performance.now() - metadataStarted);
    let page: Page | undefined;
    const stopPage = (): void => { void page?.close().catch(() => undefined); };
    try {
      throwIfStopped(context, 'navigating', this.id);
      const newPageStarted = performance.now();
      page = await this.#browser.newPage();
      timings.newPageMs = Math.round(performance.now() - newPageStarted);
      await page.addInitScript('globalThis.__name = (target) => target');
      context.signal.addEventListener('abort', stopPage, { once: true });
      emitProgress(context, { stage: 'navigating', attempt, message: `Opening ${this.url}` });
      const navigationStarted = performance.now();
      let response;
      try {
        response = await page.goto(this.url, {
          waitUntil: 'domcontentloaded',
          timeout: navigationTimeout(context),
        });
      } catch (cause) {
        throwIfStopped(context, 'navigating', this.id);
        throw new HltvError('failed to navigate to the HLTV match page', {
          code: 'NAVIGATION_FAILED', operation: 'match-detail', stage: 'navigating', retryable: true,
          matchId: this.id, cause,
        });
      }
      timings.navigationMs = Math.round(performance.now() - navigationStarted);
      const httpStatus = response?.status() ?? null;
      classifyHttp(httpStatus);
      const options: MatchCaptureOptions = {
        ...this.#identity,
        context,
        pageReadyTimeoutMs: this.#pageReadyTimeoutMs,
        scorebotReadyTimeoutMs: this.#scorebotReadyTimeoutMs,
      };
      validateFinalUrl(page.url(), options);
      emitProgress(context, {
        stage: 'extracting-page',
        attempt,
        message: 'Waiting for and extracting match sections',
      });
      const pageReadyStarted = performance.now();
      const initialPage = await waitForStableMatchPage(page, options);
      timings.pageReadyMs = Math.round(performance.now() - pageReadyStarted);
      validateFinalUrl(initialPage.url, options);
      if (initialPage.match.id !== this.id) {
        throw new HltvError('the loaded page contains a different match ID', {
          code: 'INCOMPLETE_CAPTURE', operation: 'match-detail', stage: 'validating-source', retryable: false,
          matchId: this.id,
          details: { expectedId: this.id, pageId: initialPage.match.id },
        });
      }
      if (initialPage.sections.cloudflareChallenge) {
        throw new HltvError('HLTV returned an access challenge', {
          code: 'ACCESS_BLOCKED', operation: 'match-detail', stage: 'navigating', retryable: true,
          matchId: this.id,
        });
      }
      if (!initialPage.sections.matchPage) {
        throw new HltvError('the HLTV match page root did not load', {
          code: 'NAVIGATION_FAILED', operation: 'match-detail', stage: 'extracting-page', retryable: true,
          matchId: this.id,
        });
      }
      this.#initialized = {
        page,
        initialPage,
        versions,
        httpStatus,
        timings,
        openedAtMs: Date.now(),
      };
      return this.#initialized;
    } catch (error) {
      await page?.close().catch(() => undefined);
      throw error;
    } finally {
      context.signal.removeEventListener('abort', stopPage);
    }
  }
}
