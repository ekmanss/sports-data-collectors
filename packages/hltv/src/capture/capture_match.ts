import type { Browser, Page } from 'playwright-core';
import { matchIdentityFromUrl, type MatchIdentity } from '../config.js';
import { HltvError, asHltvError } from '../errors.js';
import { extractHltvMatchPage } from '../extractors/match_page.js';
import { collectorVersions } from '../metadata.js';
import {
  abortableDelay,
  emitProgress,
  navigationTimeout,
  remainingMs,
  throwIfStopped,
  type OperationContext,
} from '../runtime.js';
import type {
  CaptureAttempt,
  RawExtractedPage,
  RawLogEvent,
  RawScoreboard,
  RawSnapshot,
} from '../types.js';

export interface MatchCaptureOptions extends MatchIdentity {
  context: OperationContext;
  pageSettleMs: number;
  scorebotSettleMs: number;
}

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

async function extractFullGameLog(page: Page): Promise<{ scrollHeight: number; chronological: RawLogEvent[] }> {
  const dimensions = await page.evaluate(`(() => {
    const list = document.querySelector('#scoreboardElement .gamelog .list.desktop');
    return list ? { scrollHeight: list.scrollHeight, clientHeight: list.clientHeight } : null;
  })()`) as { scrollHeight: number; clientHeight: number } | null;
  if (!dimensions) return { scrollHeight: 0, chronological: [] };

  const step = Math.max(dimensions.clientHeight - 104, 156);
  const positions = Array.from({ length: Math.ceil(dimensions.scrollHeight / step) + 1 }, (_, index) => index * step);
  positions.push(dimensions.scrollHeight);
  const byTop = new Map<number, RawLogEvent>();
  for (const position of positions) {
    await page.evaluate(`(() => {
      const list = document.querySelector('#scoreboardElement .gamelog .list.desktop');
      if (list) {
        list.scrollTop = ${position};
        list.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
    })()`);
    await page.waitForTimeout(100);
    const events = await page.evaluate(`(() => {
      const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const list = document.querySelector('#scoreboardElement .gamelog .list.desktop');
      if (!list) return [];
      return [...list.querySelectorAll('.topPadding')].flatMap((row) => {
        const box = row.querySelector('.gamelogBox');
        if (!box) return [];
        const tokens = [];
        const visit = (node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            const value = clean(node.textContent);
            if (value) tokens.push(value);
          } else if (node instanceof HTMLImageElement) {
            const alt = clean(node.alt);
            if (alt) tokens.push(alt);
          } else node.childNodes.forEach(visit);
        };
        visit(box);
        return [{
          top: Number.parseInt(row.style.top || '0', 10),
          type: [...box.classList].filter((name) => name !== 'gamelogBox'),
          text: clean(tokens.join(' ')).replace(/\\s+([),])/g, '$1').replace(/([(])\\s+/g, '$1'),
          players: [...box.querySelectorAll('.ctplayer,.tplayer')].map((player) => ({
            name: clean(player.textContent), side: player.classList.contains('ctplayer') ? 'CT' : 'T',
          })),
          weapon: box.querySelector('.playerWeapon')?.src.split('/').pop()?.replace('.png', '') || null,
          headshot: Boolean(box.querySelector('.headshotIcon')),
        }];
      });
    })()`) as RawLogEvent[];
    for (const event of events) byTop.set(event.top, event);
  }
  return { scrollHeight: dimensions.scrollHeight, chronological: [...byTop.values()].sort((left, right) => right.top - left.top) };
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

async function collectSnapshot(page: Page, httpStatus: number | null): Promise<RawSnapshot> {
  const pageData = await evaluatePage(page);
  const normal = await extractScoreboard(page);
  let advanced: RawScoreboard | null = null;
  if (await switchScoreboard(page, 'Advanced')) {
    advanced = await extractScoreboard(page);
    await switchScoreboard(page, 'Normal');
  }
  const rawLog = await extractFullGameLog(page);
  const chronological = formalGameLog(rawLog.chronological);
  return {
    capturedAt: new Date().toISOString(), httpStatus, page: pageData,
    scoreboardNormal: normal, scoreboardAdvanced: advanced,
    gameLog: {
      scrollHeight: rawLog.scrollHeight,
      chronological,
      excludedNoiseEvents: rawLog.chronological.length - chronological.length,
    },
    note: normal ? null : 'Scorebot was not present for this match state.',
  };
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
  const versions = await collectorVersions();
  let page: Page | null = null;
  const stopPage = (): void => { void page?.close().catch(() => undefined); };
  try {
    throwIfStopped(options.context, 'navigating', options.id);
    page = await browser.newPage();
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
    classifyHttp(response?.status() ?? null);
    validateFinalUrl(page.url(), options);
    emitProgress(options.context, { stage: 'extracting-page', attempt, message: 'Waiting for and extracting match sections' });
    await abortableDelay(options.pageSettleMs, options.context, 'extracting-page', options.id);
    const initialPage = await evaluatePage(page);
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
    let scorebotPresent = await page.locator('#scoreboardElement .scoreboard').count() > 0;
    if (!scorebotPresent) {
      await installScorebotFallback(page, fallbackConfig(options, initialPage));
      response = await page.reload({ waitUntil: 'domcontentloaded', timeout: navigationTimeout(options.context) });
      classifyHttp(response?.status() ?? null);
      validateFinalUrl(page.url(), options);
    }
    await abortableDelay(options.scorebotSettleMs, options.context, 'extracting-scorebot', options.id);
    if (!scorebotPresent) {
      await page.waitForSelector('#scoreboardElement .scoreboard', {
        timeout: Math.max(1, Math.min(10_000, remainingMs(options.context))),
      }).catch(() => null);
      throwIfStopped(options.context, 'extracting-scorebot', options.id);
      scorebotPresent = await page.locator('#scoreboardElement .scoreboard').count() > 0;
    }
    const snapshot = await collectSnapshot(page, response?.status() ?? null);
    validateFinalUrl(snapshot.page.url, options);
    if (snapshot.page.match.id !== options.id) {
      throw new HltvError('the final page snapshot contains a different match ID', {
        code: 'INCOMPLETE_CAPTURE', operation: 'match-detail', stage: 'validating-source', retryable: false,
        matchId: options.id, details: { pageId: snapshot.page.match.id },
      });
    }
    const status = initialPage.match.status.toLowerCase();
    const requiresScorebot = status.includes('live') || status.includes('over');
    if (requiresScorebot && !scorebotPresent) {
      throw new HltvError('Scorebot data is required for this match state but was unavailable', {
        code: 'INCOMPLETE_CAPTURE', operation: 'match-detail', stage: 'extracting-scorebot', retryable: false,
        matchId: options.id,
      });
    }
    const completedAt = new Date().toISOString();
    return {
      initialPage,
      snapshot,
      collector: versions,
      httpStatus: response?.status() ?? null,
      navigationSeconds: Number(((performance.now() - navigationStarted) / 1000).toFixed(3)),
      totalSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
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
    await page?.close().catch(() => undefined);
  }
}
