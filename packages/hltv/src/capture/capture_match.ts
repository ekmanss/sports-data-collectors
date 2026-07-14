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

function fallbackConfig(options: MatchCaptureOptions, page: RawExtractedPage): Record<string, string> {
  const [first, second] = page.teams;
  if (!first?.id || !second?.id) {
    throw new HltvError('cannot restore Scorebot without two identified teams', {
      code: 'INCOMPLETE_CAPTURE', operation: 'match-detail', stage: 'extracting-scorebot', retryable: false,
    });
  }
  return {
    scorebotUrl: 'https://scorebot-lb.hltv.org', scorebotId: String(options.id), hideMapBeforeLive: 'false',
    team1Id: String(first.id), team1Name: first.name, team1Logo: first.logo ?? '',
    team2Id: String(second.id), team2Name: second.name, team2Logo: second.logo ?? '',
    csVersion: 'CS2', maxRoundsRegulation: '12', maxRoundsOvertime: '3',
  };
}

async function installScorebotFallback(page: Page, config: Record<string, string>): Promise<void> {
  await page.addInitScript(`
    document.addEventListener('DOMContentLoaded', () => {
      if (document.querySelector('#scoreboardElement')) return;
      const element = document.createElement('div');
      element.id = 'scoreboardElement';
      Object.assign(element.dataset, ${JSON.stringify(config)});
      document.body.prepend(element);
    }, { once: true });
  `);
}

async function collectSnapshot(
  page: Page,
  httpStatus: number | null,
  timings: MatchCaptureTimings,
): Promise<RawSnapshot> {
  const pageStarted = performance.now();
  const pageData = await evaluatePage(page);
  timings.snapshotPageMs = Math.round(performance.now() - pageStarted);
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
};

async function scorebotState(page: Page): Promise<ScorebotState> {
  return await page.evaluate(() => {
    const root = document.querySelector('#scoreboardElement .scoreboard');
    const list = document.querySelector<HTMLElement>('#scoreboardElement .gamelog .list.desktop');
    if (!root) return { present: false, ready: false, signature: '' };
    const clean = (value: string | null | undefined): string =>
      (value || '').replace(/\s+/g, ' ').trim();
    const score = clean(root.querySelector('.scoreText')?.textContent);
    const round = clean(root.querySelector('.currentRoundText')?.textContent);
    const playerRows = root.querySelectorAll('table.team tr').length;
    const visibleLogRows = list?.querySelectorAll('.topPadding').length ?? 0;
    const scoreTotal = score.split(/\D+/).reduce(
      (sum, value) => sum + (Number(value) || 0),
      0,
    );
    const needsGameLog = scoreTotal > 0 || !/^1\b/.test(round);
    const gameLogReady = Boolean(list) && (!needsGameLog || visibleLogRows > 0);
    return {
      present: true,
      ready: playerRows >= 4 && Boolean(score) && Boolean(round) && gameLogReady,
      signature: JSON.stringify({
        score,
        round,
        playerRows,
        scrollHeight: list?.scrollHeight ?? 0,
        visibleLogRows,
      }),
    };
  });
}

async function waitForStableScorebot(
  page: Page,
  options: MatchCaptureOptions,
): Promise<ScorebotState> {
  const started = performance.now();
  let previousSignature: string | null = null;
  let latest: ScorebotState = { present: false, ready: false, signature: '' };
  while (performance.now() - started < options.scorebotReadyTimeoutMs) {
    throwIfStopped(options.context, 'extracting-scorebot', options.id);
    latest = await scorebotState(page);
    if (latest.ready && latest.signature === previousSignature) return latest;
    previousSignature = latest.ready ? latest.signature : null;
    await abortableDelay(
      STABILITY_POLL_MS,
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
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const timings: MatchCaptureTimings = {
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
  const metadataStarted = performance.now();
  const versions = await collectorVersions();
  timings.metadataMs = Math.round(performance.now() - metadataStarted);
  let page: Page | null = null;
  const stopPage = (): void => { void page?.close().catch(() => undefined); };
  try {
    throwIfStopped(options.context, 'navigating', options.id);
    const newPageStarted = performance.now();
    page = await browser.newPage();
    timings.newPageMs = Math.round(performance.now() - newPageStarted);
    await page.addInitScript('globalThis.__name = (target) => target');
    options.context.signal.addEventListener('abort', stopPage, { once: true });
    emitProgress(options.context, { stage: 'navigating', attempt, message: `Opening ${options.url}` });
    const navigationStarted = performance.now();
    let response;
    try {
      response = await page.goto(options.url, {
        waitUntil: 'domcontentloaded',
        timeout: navigationTimeout(options.context),
      });
    } catch (cause) {
      throwIfStopped(options.context, 'navigating', options.id);
      throw new HltvError('failed to navigate to the HLTV match page', {
        code: 'NAVIGATION_FAILED', operation: 'match-detail', stage: 'navigating', retryable: true,
        matchId: options.id, cause,
      });
    }
    timings.navigationMs = Math.round(performance.now() - navigationStarted);
    classifyHttp(response?.status() ?? null);
    validateFinalUrl(page.url(), options);
    emitProgress(options.context, { stage: 'extracting-page', attempt, message: 'Waiting for and extracting match sections' });
    const pageReadyStarted = performance.now();
    const initialPage = await waitForStableMatchPage(page, options);
    timings.pageReadyMs = Math.round(performance.now() - pageReadyStarted);
    validateFinalUrl(initialPage.url, options);
    if (initialPage.match.id !== options.id) {
      throw new HltvError('the loaded page contains a different match ID', {
        code: 'INCOMPLETE_CAPTURE', operation: 'match-detail', stage: 'validating-source', retryable: false,
        matchId: options.id,
        details: { expectedId: options.id, pageId: initialPage.match.id },
      });
    }
    if (initialPage.sections.cloudflareChallenge) {
      throw new HltvError('HLTV returned an access challenge', {
        code: 'ACCESS_BLOCKED', operation: 'match-detail', stage: 'navigating', retryable: true, matchId: options.id,
      });
    }
    if (!initialPage.sections.matchPage) {
      throw new HltvError('the HLTV match page root did not load', {
        code: 'NAVIGATION_FAILED', operation: 'match-detail', stage: 'extracting-page', retryable: true, matchId: options.id,
      });
    }

    emitProgress(options.context, { stage: 'extracting-scorebot', attempt, message: 'Extracting Normal/Advanced scoreboard and Game log' });
    const status = initialPage.match.status.toLowerCase();
    const requiresScorebot = status.includes('live') || status.includes('over');
    let state = await scorebotState(page);
    if (requiresScorebot && !state.present) {
      await installScorebotFallback(page, fallbackConfig(options, initialPage));
      const reloadStarted = performance.now();
      response = await page.reload({ waitUntil: 'domcontentloaded', timeout: navigationTimeout(options.context) });
      timings.scorebotReloadMs = Math.round(performance.now() - reloadStarted);
      classifyHttp(response?.status() ?? null);
      validateFinalUrl(page.url(), options);
    }
    if (requiresScorebot) {
      const scorebotReadyStarted = performance.now();
      await waitForStableScorebot(page, options);
      timings.scorebotReadyMs = Math.round(performance.now() - scorebotReadyStarted);
    }
    const snapshot = await collectSnapshot(page, response?.status() ?? null, timings);
    validateFinalUrl(snapshot.page.url, options);
    if (snapshot.page.match.id !== options.id) {
      throw new HltvError('the final page snapshot contains a different match ID', {
        code: 'INCOMPLETE_CAPTURE', operation: 'match-detail', stage: 'validating-source', retryable: false,
        matchId: options.id, details: { pageId: snapshot.page.match.id },
      });
    }
    const completedAt = new Date().toISOString();
    return {
      initialPage,
      snapshot,
      collector: versions,
      httpStatus: response?.status() ?? null,
      navigationSeconds: Number((timings.navigationMs / 1000).toFixed(3)),
      totalSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
      timings,
      attempt,
      startedAt,
      completedAt,
    };
  } catch (error) {
    throwIfStopped(options.context, 'extracting-page', options.id);
    throw asHltvError(error, {
      code: 'INTERNAL_ERROR', operation: 'match-detail', stage: 'extracting-page', retryable: false, matchId: options.id,
    });
  } finally {
    options.context.signal.removeEventListener('abort', stopPage);
    const pageCloseStarted = performance.now();
    await page?.close().catch(() => undefined);
    timings.pageCloseMs = Math.round(performance.now() - pageCloseStarted);
  }
}
