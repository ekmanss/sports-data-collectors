import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { binaryInfo, launch } from 'cloakbrowser';
import type { Page } from 'playwright-core';
import { emitProgress, throwIfAborted } from '../config.js';
import { HltvMatchError, asHltvMatchError } from '../errors.js';
import type {
  CaptureAttempt,
  NormalizedGetHltvMatchOptions,
  RawExtractedPage,
  RawLogEvent,
  RawPageCapture,
  RawScoreboard,
  RawSnapshot,
} from '../types.js';

const ROOT = resolve(import.meta.dirname, '../..');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExtractedPage(value: unknown): asserts value is RawExtractedPage {
  if (!isRecord(value) || !isRecord(value.match) || !Array.isArray(value.teams) || !isRecord(value.maps) || !Array.isArray(value.lineups)) {
    throw new HltvMatchError('HLTV page returned an unrecognized match payload', {
      code: 'INCOMPLETE_CAPTURE', stage: 'extracting-page', retryable: false,
    });
  }
  if (typeof value.url !== 'string' || typeof value.title !== 'string' || !isRecord(value.sections)) {
    throw new HltvMatchError('HLTV page metadata is incomplete', {
      code: 'INCOMPLETE_CAPTURE', stage: 'extracting-page', retryable: false,
    });
  }
}

function expectedPath(options: NormalizedGetHltvMatchOptions): string {
  return `/matches/${options.id}/${options.slug}`;
}

function validateFinalUrl(finalUrl: string, options: NormalizedGetHltvMatchOptions): void {
  let url: URL;
  try {
    url = new URL(finalUrl);
  } catch (cause) {
    throw new HltvMatchError('HLTV returned an invalid final URL', {
      code: 'SLUG_MISMATCH', stage: 'validating-source', retryable: false, cause,
    });
  }
  const path = url.pathname.replace(/\/$/, '');
  if (url.protocol !== 'https:' || url.hostname !== 'www.hltv.org' || path !== expectedPath(options)) {
    throw new HltvMatchError(`final HLTV path ${path} does not match the requested match`, {
      code: 'SLUG_MISMATCH', stage: 'validating-source', retryable: false,
      matchId: String(options.id), slug: options.slug,
      details: { expectedPath: expectedPath(options), finalPath: path },
    });
  }
}

async function abortableDelay(milliseconds: number, options: NormalizedGetHltvMatchOptions, stage: 'extracting-page' | 'extracting-scorebot'): Promise<void> {
  throwIfAborted(options, stage);
  if (milliseconds === 0) return;
  await new Promise<void>((resolveDelay, reject) => {
    const timer = setTimeout(done, milliseconds);
    const signal = options.signal;
    function done(): void {
      signal?.removeEventListener('abort', aborted);
      resolveDelay();
    }
    function aborted(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(new HltvMatchError('capture was aborted', {
        code: 'ABORTED', stage, retryable: false, matchId: String(options.id), slug: options.slug,
      }));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

async function evaluatePage(page: Page, extractor: string): Promise<RawExtractedPage> {
  await page.evaluate('globalThis.__name = (target) => target');
  const extracted: unknown = await page.evaluate(`(${extractor})()`);
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

function fallbackConfig(options: NormalizedGetHltvMatchOptions, page: RawExtractedPage): Record<string, string> {
  const [first, second] = page.teams;
  if (!first?.id || !second?.id) {
    throw new HltvMatchError('cannot restore Scorebot without two identified teams', {
      code: 'INCOMPLETE_CAPTURE', stage: 'extracting-scorebot', retryable: false,
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

async function collectSnapshot(page: Page, httpStatus: number | null, extractor: string): Promise<RawSnapshot> {
  const pageData = await evaluatePage(page, extractor);
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
    throw new HltvMatchError('HLTV match page was not found', { code: 'MATCH_NOT_FOUND', stage: 'navigating', retryable: false });
  }
  if (status === 403) {
    throw new HltvMatchError('HLTV denied access to the match page', { code: 'ACCESS_BLOCKED', stage: 'navigating', retryable: false });
  }
  if (status === 429 || (status !== null && status >= 500)) {
    throw new HltvMatchError(`HLTV returned HTTP ${status}`, { code: 'NAVIGATION_FAILED', stage: 'navigating', retryable: true, details: { httpStatus: status } });
  }
}

export async function captureMatch(options: NormalizedGetHltvMatchOptions, attempt: number): Promise<CaptureAttempt> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const extractor = await readFile(resolve(ROOT, 'shared/hltv_dom_extract.js'), 'utf8');
  const cloakPackage = JSON.parse(await readFile(resolve(ROOT, 'node_modules/cloakbrowser/package.json'), 'utf8')) as { version: string };
  const playwrightPackage = JSON.parse(await readFile(resolve(ROOT, 'node_modules/playwright-core/package.json'), 'utf8')) as { version: string };
  const browserDetails = binaryInfo();
  emitProgress(options, { stage: 'launching-browser', attempt, message: 'Launching CloakBrowser' });
  let browser: Awaited<ReturnType<typeof launch>> | null = null;
  try {
    throwIfAborted(options, 'launching-browser');
    try {
      browser = await launch({ headless: options.headless, locale: 'en-US', timezone: 'Asia/Singapore' });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const missing = /install|binary|executable|browser/i.test(message);
      throw new HltvMatchError(missing ? 'CloakBrowser is not installed; run: pnpm exec cloakbrowser install' : message, {
        code: missing ? 'BROWSER_NOT_INSTALLED' : 'NAVIGATION_FAILED', stage: 'launching-browser', retryable: !missing, cause,
      });
    }
    const page = await browser.newPage();
    emitProgress(options, { stage: 'navigating', attempt, message: `Opening ${options.url}` });
    const navigationStarted = performance.now();
    let response;
    try {
      response = await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    } catch (cause) {
      throw new HltvMatchError('failed to navigate to the HLTV match page', {
        code: 'NAVIGATION_FAILED', stage: 'navigating', retryable: true, cause,
      });
    }
    classifyHttp(response?.status() ?? null);
    validateFinalUrl(page.url(), options);
    emitProgress(options, { stage: 'extracting-page', attempt, message: 'Waiting for and extracting match sections' });
    await abortableDelay(options.pageWaitMs, options, 'extracting-page');
    const initialPage = await evaluatePage(page, extractor);
    validateFinalUrl(initialPage.url, options);
    if (initialPage.match.id !== options.id) {
      throw new HltvMatchError('the loaded page contains a different match ID', {
        code: 'SLUG_MISMATCH', stage: 'validating-source', retryable: false,
        details: { expectedId: options.id, pageId: initialPage.match.id },
      });
    }
    if (initialPage.sections.cloudflareChallenge) {
      throw new HltvMatchError('HLTV returned an access challenge', { code: 'ACCESS_BLOCKED', stage: 'navigating', retryable: false });
    }
    if (!initialPage.sections.matchPage) {
      throw new HltvMatchError('the HLTV match page root did not load', { code: 'NAVIGATION_FAILED', stage: 'extracting-page', retryable: true });
    }

    emitProgress(options, { stage: 'extracting-scorebot', attempt, message: 'Extracting Normal/Advanced scoreboard and Game log' });
    let scorebotPresent = await page.locator('#scoreboardElement .scoreboard').count() > 0;
    if (!scorebotPresent) {
      await installScorebotFallback(page, fallbackConfig(options, initialPage));
      response = await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
      classifyHttp(response?.status() ?? null);
      validateFinalUrl(page.url(), options);
    }
    await abortableDelay(options.scorebotWaitMs, options, 'extracting-scorebot');
    if (!scorebotPresent) {
      await page.waitForSelector('#scoreboardElement .scoreboard', { timeout: 10_000 }).catch(() => null);
      scorebotPresent = await page.locator('#scoreboardElement .scoreboard').count() > 0;
    }
    const snapshot = await collectSnapshot(page, response?.status() ?? null, extractor);
    const status = initialPage.match.status.toLowerCase();
    const requiresScorebot = status.includes('live') || status.includes('over');
    if (requiresScorebot && !scorebotPresent) {
      throw new HltvMatchError('Scorebot data is required for this match state but was unavailable', {
        code: 'INCOMPLETE_CAPTURE', stage: 'extracting-scorebot', retryable: false,
      });
    }
    const html = await page.content();
    const completedAt = new Date().toISOString();
    const pageCapture: RawPageCapture = {
      language: 'TypeScript', runtime: process.version,
      cloakbrowser_version: cloakPackage.version, playwright_version: playwrightPackage.version,
      browser_version: String(browserDetails.version), browser_tier: String(browserDetails.tier),
      headless: options.headless, wait_ms: options.pageWaitMs,
      http_status: response?.status() ?? null,
      navigation_seconds: Number(((performance.now() - navigationStarted) / 1000).toFixed(3)),
      total_seconds: Number(((performance.now() - started) / 1000).toFixed(3)),
      html_bytes: Buffer.byteLength(html), html_sha256: createHash('sha256').update(html).digest('hex'),
      extracted: initialPage, error: null,
    };
    return { page: pageCapture, snapshot, html, attempt, startedAt, completedAt };
  } catch (error) {
    throw asHltvMatchError(error, { code: 'INTERNAL_ERROR', stage: 'extracting-page', retryable: false, matchId: String(options.id), slug: options.slug });
  } finally {
    await browser?.close();
  }
}
