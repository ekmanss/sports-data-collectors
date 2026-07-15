import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import type { HltvBrowserAdapter } from '../src/browser_adapter.js';
import { createHltvClientWithBrowser, selectMatchSessionEvictions } from '../src/client.js';
import { LiveCaptureSession } from '../src/capture/capture_live.js';
import {
  extractFullGameLog,
  isExtractedScorebotUsable,
  isScorebotSemanticallyReady,
  MatchCaptureSession,
} from '../src/capture/capture_match.js';
import { matchIdentityFromUrl, normalizeClientOptions } from '../src/config.js';
import { HltvError, withHltvErrorDetails } from '../src/errors.js';
import { createOperationContext, retryDelayMilliseconds } from '../src/runtime.js';
import { assignRoundTeamResults, buildConsumerFromCapture } from '../src/transform/build_consumer.js';
import { validateMatch } from '../src/transform/validate_match.js';
import type {
  CaptureAttempt, HltvMatch, MatchDiagnostics, MatchMap, RawExtractedPage, RawLivePage, RawLogEvent,
  RawScoreboard,
} from '../src/types.js';

const fixturePath = resolve(
  import.meta.dirname,
  'fixtures/completed-match.json',
);
// Keep the legacy 3.0.0 fixture useful while testing the additive contract and corrected
// side/team-score semantics.
const legacyCompletedFixture = JSON.parse(await readFile(fixturePath, 'utf8')) as HltvMatch;
for (const map of legacyCompletedFixture.maps) {
  let ctWins = 0;
  let tWins = 0;
  for (const round of map.gameLog.rounds) {
    if (round.result?.winnerSide === 'CT') ctWins += 1;
    if (round.result?.winnerSide === 'T') tWins += 1;
    if (round.result) round.result.sideScore = { ct: ctWins, t: tWins };
  }
}
const completedFixture = {
  ...legacyCompletedFixture,
  schemaVersion: '3.2.0',
  matchStats: { views: [] },
} satisfies HltvMatch;
const fixturePlayerTeams = new Map(
  completedFixture.lineups.flatMap((lineup) =>
    lineup.playerIds.map((playerId) => [playerId, lineup.teamId] as const)),
);
for (const map of completedFixture.maps) {
  for (const round of map.gameLog.rounds) {
    for (const event of round.events) {
      for (const player of event.players ?? []) {
        player.teamId ??= player.playerId === null
          ? null
          : fixturePlayerTeams.get(player.playerId) ?? null;
      }
    }
  }
  map.gameLog.rounds = assignRoundTeamResults(
    map.gameLog.rounds,
    completedFixture.teams.map((team) => team.id),
  );
  for (const team of map.scoreboard?.teams ?? []) team.side ??= null;
}
for (const team of completedFixture.current?.scoreboard?.teams ?? []) team.side ??= null;
const rawSections = { sections: { matchPage: true, maps: true } };

function diagnosticsFor(match: HltvMatch): MatchDiagnostics {
  return {
    schemaVersion: '3.0.0',
    operation: 'match-detail',
    startedAt: match.capturedAt,
    completedAt: match.capturedAt,
    durationMs: 0,
    collector: { packageVersion: '0.0.0', cloakbrowserVersion: '0.4.10', playwrightVersion: '1.61.0' },
    input: { id: match.match.id, slug: match.match.slug, url: match.source.url },
    attempts: [],
    capture: {},
    reconciliation: {},
    mapChecks: Object.fromEntries(match.maps.map((map) => {
      const completedRounds = map.gameLog.rounds.filter((round) => round.result).length;
      const scoreSum = map.score.reduce((sum, entry) => sum + entry.score, 0);
      return [map.name, {
        status: map.status,
        scoreSum,
        completedRounds,
        consistent: map.status === 'upcoming' || scoreSum === completedRounds,
        scoreboardIncluded: Boolean(map.scoreboard),
      }];
    })),
    mergedRecentModes: [],
    warnings: [],
  };
}

function cloneFixture(): HltvMatch {
  return structuredClone(completedFixture);
}

function completedStatsPage(): RawExtractedPage {
  const player = (id: number, nickname: string) => ({
    id,
    nickname,
    fullName: nickname,
    country: null,
    image: null,
    profileUrl: null,
    statsUrl: null,
    rating: null,
    kpr: null,
    dpr: null,
    kast: null,
    adr: null,
    stats: {},
  });
  const metricPlayer = (id: number, nickname: string, kills: string, deaths: string) => ({
    id,
    nickname,
    kills,
    deaths,
    ecoAdjustedKills: String(Number(kills) + 1),
    ecoAdjustedDeaths: String(Number(deaths) - 1),
    roundSwing: '+2.50%',
    adr: '80.5',
    ecoAdjustedAdr: '82.1',
    kast: '75.0%',
    ecoAdjustedKast: '77.5%',
    rating: '1.20',
  });
  const view = (
    mapStatsId: number | null,
    map: string | null,
    side: 'both' | 'ct' | 't',
  ) => ({
    mapStatsId,
    map,
    side,
    teams: [
      { id: 1, name: 'Alpha', players: [metricPlayer(11, 'alpha-one', '13', '8')] },
      { id: 2, name: 'Bravo', players: [metricPlayer(21, 'bravo-one', '8', '13')] },
    ],
  });
  return {
    title: 'Alpha vs Bravo',
    url: 'https://www.hltv.org/matches/2395903/alpha-vs-bravo-event',
    match: {
      id: 2395903,
      status: 'Match over',
      scheduledUnixMs: 1_784_000_000_000,
      event: { id: 1, name: 'Event', url: 'https://www.hltv.org/events/1/event' },
    },
    teams: [
      { id: 1, name: 'Alpha', url: null, country: null, logo: null },
      { id: 2, name: 'Bravo', url: null, country: null, logo: null },
    ],
    maps: {
      format: 'Best of 1',
      stage: 'Group stage',
      veto: [],
      maps: [{
        name: 'Ancient',
        optional: false,
        halfScores: '(6:6; 7:2)',
        teams: [
          { name: 'Alpha', score: '13', picked: false },
          { name: 'Bravo', score: '8', picked: false },
        ],
      }],
    },
    streams: [],
    lineups: [
      { id: 1, name: 'Alpha', worldRank: 1, players: [player(11, 'alpha-one')] },
      { id: 2, name: 'Bravo', worldRank: 2, players: [player(21, 'bravo-one')] },
    ],
    matchStats: {
      views: [
        view(null, null, 'both'),
        view(232_999, 'Ancient', 'ct'),
        view(232_999, 'Ancient', 't'),
      ],
    },
    mapStats: null,
    recentMatches: [],
    headToHead: null,
    sections: { matchPage: true, maps: true, matchStats: true },
  };
}

function captureForPage(page: RawExtractedPage): CaptureAttempt {
  const capturedAt = '2026-07-15T22:26:28.954Z';
  return {
    initialPage: page,
    snapshot: {
      capturedAt,
      httpStatus: 200,
      page,
      scoreboardNormal: null,
      scoreboardAdvanced: null,
      gameLog: { scrollHeight: 0, chronological: [], excludedNoiseEvents: 0 },
      note: null,
    },
    collector: {
      packageVersion: '0.0.0',
      cloakbrowserVersion: '0.4.10',
      playwrightVersion: '1.61.0',
    },
    httpStatus: 200,
    navigationSeconds: 0,
    totalSeconds: 0,
    attempt: 1,
    startedAt: capturedAt,
    completedAt: capturedAt,
  };
}

test('ignores an empty recent-match placeholder without hiding partial source data', () => {
  const page = completedStatsPage();
  page.recentMatches = [{
    mode: 'team',
    teams: [
      {
        teamId: 1,
        matches: [{
          opponentId: 2,
          opponent: 'Bravo',
          opponentCountry: null,
          opponentUrl: 'https://www.hltv.org/team/2/bravo',
          timeAgo: '1 week ago',
          format: 'bo3',
          score: '2 - 0',
          result: 'won',
          matchId: 2395000,
          matchUrl: 'https://www.hltv.org/matches/2395000/alpha-vs-bravo-event',
        }],
      },
      {
        teamId: 2,
        matches: [
          {
            opponentId: null,
            opponent: '',
            opponentCountry: null,
            opponentUrl: null,
            timeAgo: '',
            format: '',
            score: '',
            result: null,
            matchId: null,
            matchUrl: null,
          },
          {
            opponentId: null,
            opponent: 'Visible but incomplete opponent',
            opponentCountry: null,
            opponentUrl: null,
            timeAgo: '',
            format: '',
            score: '',
            result: null,
            matchId: null,
            matchUrl: null,
          },
        ],
      },
    ],
  }];

  const result = buildConsumerFromCapture(captureForPage(page), []);

  assert.deepEqual(result.data.recentMatches.views[0]!.teams[0]!.matches[0]!.match, {
    id: 2395000,
    url: 'https://www.hltv.org/matches/2395000/alpha-vs-bravo-event',
  });
  assert.deepEqual(result.data.recentMatches.views[0]!.teams[1]!.matches, [{
    opponent: {
      id: null,
      name: 'Visible but incomplete opponent',
      country: null,
      url: null,
    },
    timeAgo: null,
    format: '',
    score: null,
    result: null,
    match: { id: null, url: null },
  }]);
});

test('keeps team scores stable when the same team wins on both sides of a swap', () => {
  const rounds = assignRoundTeamResults([
    {
      number: 1,
      events: [{
        kind: 'playerKill',
        text: 'alpha killed bravo',
        players: [
          { playerId: 11, teamId: 1, side: 'T' },
          { playerId: 21, teamId: 2, side: 'CT' },
        ],
      }],
      result: {
        winnerSide: 'T', winnerTeamId: null, teamScore: null,
        sideScore: { ct: 0, t: 1 }, reason: 'Enemy eliminated',
      },
    },
    {
      number: 2,
      events: [{
        kind: 'playerKill',
        text: 'alpha killed bravo after side swap',
        players: [
          { playerId: 11, teamId: 1, side: 'CT' },
          { playerId: 21, teamId: 2, side: 'T' },
        ],
      }],
      result: {
        winnerSide: 'CT', winnerTeamId: null, teamScore: null,
        sideScore: { ct: 1, t: 1 }, reason: 'Enemy eliminated',
      },
    },
  ], [1, 2]);

  assert.deepEqual(rounds.map((round) => round.result), [
    {
      winnerSide: 'T', winnerTeamId: 1,
      teamScore: [{ teamId: 1, score: 1 }, { teamId: 2, score: 0 }],
      sideScore: { ct: 0, t: 1 }, reason: 'Enemy eliminated',
    },
    {
      winnerSide: 'CT', winnerTeamId: 1,
      teamScore: [{ teamId: 1, score: 2 }, { teamId: 2, score: 0 }],
      sideScore: { ct: 1, t: 1 }, reason: 'Enemy eliminated',
    },
  ]);
});

test('parses and canonicalizes a complete HLTV match URL', () => {
  assert.deepEqual(
    matchIdentityFromUrl(`${completedFixture.source.url}/?ref=test#scorebot`),
    {
      id: completedFixture.match.id,
      slug: completedFixture.match.slug,
      url: completedFixture.source.url,
    },
  );
  assert.equal(matchIdentityFromUrl('https://example.com/matches/2395674/not-hltv'), null);
  assert.equal(matchIdentityFromUrl('https://www.hltv.org/matches/2395674'), null);
});

test('defaults browser timezone to the runtime timezone and accepts an explicit egress timezone', () => {
  const defaults = normalizeClientOptions();
  assert.equal(
    defaults.timezone,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  assert.equal(defaults.livePageRefreshIntervalMs, 2 * 60_000);
  assert.equal(defaults.matchSessionIdleTimeoutMs, 30 * 60_000);
  assert.equal(defaults.maxMatchSessions, 10);
  assert.equal(
    normalizeClientOptions({ timezone: 'America/Los_Angeles' }).timezone,
    'America/Los_Angeles',
  );
});

test('keeps one live-list page open, reads it directly, and periodically refreshes the same page', async () => {
  const livePage: RawLivePage = {
    title: 'Counter-Strike Matches & livescore',
    url: 'https://www.hltv.org/matches',
    recognized: true,
    challenge: false,
    cardsSeen: 1,
    cards: [{
      id: 2395902,
      url: 'https://www.hltv.org/matches/2395902/alpha-vs-bravo-event',
      bestOf: 3,
      region: 'Europe',
      isLan: false,
      event: { id: 1, name: 'Event', type: 'Online', logoUrl: null },
      teams: [
        { id: 1, name: 'Alpha', logoUrl: null, currentMap: 3, mapsWon: 0 },
        { id: 2, name: 'Bravo', logoUrl: null, currentMap: 2, mapsWon: 0 },
      ],
    }],
  };
  let now = 0;
  let newPageCalls = 0;
  let navigationCalls = 0;
  let closeCalls = 0;
  const page = {
    addInitScript: async () => undefined,
    close: async () => { closeCalls += 1; },
    evaluate: async (expression: string | (() => unknown)) =>
      expression === 'globalThis.__name = (target) => target' ? undefined : livePage,
    goto: async () => {
      navigationCalls += 1;
      return { status: () => 200 };
    },
    isClosed: () => closeCalls > 0,
    locator: () => ({ filter: () => ({ count: async () => 0, click: async () => undefined }) }),
    url: () => livePage.url,
    waitForTimeout: async () => undefined,
  };
  const browser = {
    newPage: async () => {
      newPageCalls += 1;
      return page;
    },
  } as unknown as HltvBrowserAdapter;
  const session = new LiveCaptureSession(browser, {
    refreshIntervalMs: 10_000,
    now: () => now,
  });
  const firstContext = createOperationContext('live-list', { timeoutMs: 5_000 }, 5_000);
  const secondContext = createOperationContext('live-list', { timeoutMs: 5_000 }, 5_000);
  const thirdContext = createOperationContext('live-list', { timeoutMs: 5_000 }, 5_000);
  try {
    const first = await session.capture(firstContext, 1);
    now = 5_000;
    const second = await session.capture(secondContext, 1);
    now = 10_000;
    const third = await session.capture(thirdContext, 1);

    assert.equal(newPageCalls, 1);
    assert.equal(navigationCalls, 2);
    assert.deepEqual(first.session, { reused: false, navigated: true, ageMs: 0 });
    assert.deepEqual(second.session, { reused: true, navigated: false, ageMs: 5_000 });
    assert.deepEqual(third.session, { reused: true, navigated: true, ageMs: 10_000 });
  } finally {
    firstContext.dispose();
    secondContext.dispose();
    thirdContext.dispose();
    await session.close();
  }
  assert.equal(closeCalls, 1);
});

test('evicts idle match pages first, then the least recently used inactive page', () => {
  const entries = [
    { matchId: 1, lastUsedAt: 0, activeCaptures: 0 },
    { matchId: 2, lastUsedAt: 90_000, activeCaptures: 0 },
    { matchId: 3, lastUsedAt: 10_000, activeCaptures: 1 },
    { matchId: 4, lastUsedAt: 80_000, activeCaptures: 0 },
  ];

  assert.deepEqual(selectMatchSessionEvictions(entries, {
    now: 100_000,
    idleTimeoutMs: 50_000,
    maxSessions: 3,
    reserve: 1,
  }), [1, 4]);
  assert.deepEqual(selectMatchSessionEvictions(entries, {
    now: 100_000,
    idleTimeoutMs: 200_000,
    maxSessions: 4,
    reserve: 1,
  }), [1]);
});

test('uses a longer bounded cooldown for an access challenge', () => {
  assert.equal(retryDelayMilliseconds('ACCESS_BLOCKED', 1, 0), 10_000);
  assert.equal(retryDelayMilliseconds('ACCESS_BLOCKED', 1, 0.999_999), 12_500);
  assert.equal(retryDelayMilliseconds('ACCESS_BLOCKED', 2, 0), 20_000);
  assert.equal(retryDelayMilliseconds('ACCESS_BLOCKED', 2, 0.999_999), 25_000);
  assert.equal(retryDelayMilliseconds('NAVIGATION_FAILED', 1, 0), 2_000);
  assert.equal(retryDelayMilliseconds('NAVIGATION_FAILED', 1, 0.999_999), 2_500);
});

test('accepts one semantically complete Scorebot state without requiring it to stop changing', () => {
  const liveRound = {
    present: true,
    score: '7:5',
    round: '13 - Ancient',
    teamNames: ['Alpha', 'Bravo'],
    playerRows: 10,
    scrollHeight: 2_400,
    visibleLogRows: 18,
  };
  assert.equal(isScorebotSemanticallyReady(liveRound), true);
  assert.equal(isScorebotSemanticallyReady({ ...liveRound, round: 'R: 13 - Ancient' }), false);
  assert.equal(isScorebotSemanticallyReady({ ...liveRound, round: '1 - Unknown' }), false);
  assert.equal(isScorebotSemanticallyReady({ ...liveRound, playerRows: 0 }), false);
  assert.equal(isScorebotSemanticallyReady({ ...liveRound, scrollHeight: 0, visibleLogRows: 0 }), false);
  assert.equal(isScorebotSemanticallyReady({
    ...liveRound,
    score: '0:0',
    round: '1 - Dust2',
    scrollHeight: 0,
    visibleLogRows: 0,
  }), true);
});

test('does not accept an extracted Game log that cannot account for the visible score', () => {
  const players = Array.from({ length: 5 }, (_, index) => ({
    player: `player-${index}`,
    cells: [],
  }));
  const scoreboard: RawScoreboard = {
    mode: 'Normal',
    round: '9 - Inferno',
    fact: '',
    score: '8:0',
    teams: [
      { team: 'Alpha', players },
      { team: 'Bravo', players },
    ],
  };
  const round = (number: number): RawLogEvent => ({
    top: number,
    type: [],
    text: `Round over - Winner: CT (${number} - 0) - Enemy eliminated`,
    players: [],
    weapon: null,
    headshot: false,
  });

  assert.equal(isExtractedScorebotUsable(scoreboard, {
    scrollHeight: 400,
    chronological: [],
  }), false);
  assert.equal(isExtractedScorebotUsable(scoreboard, {
    scrollHeight: 400,
    chronological: Array.from({ length: 8 }, (_, index) => round(index + 1)),
  }), true);
});

test('accepts a caller-owned browser adapter and closes only that adapter', async () => {
  let closes = 0;
  const client = createHltvClientWithBrowser({
    newPage: async () => { throw new Error('not used'); },
    close: async () => { closes += 1; },
  });

  await client.close();
  await client.close();

  assert.equal(closes, 1);
});

test('captures every completed Match stats view without waiting for Scorebot', async () => {
  const pageData = completedStatsPage();
  let pageCloses = 0;
  let browserCloses = 0;
  let evaluations = 0;
  const page = {
    addInitScript: async () => undefined,
    close: async () => { pageCloses += 1; },
    evaluate: async (expression: string | (() => unknown)) => {
      if (expression === 'globalThis.__name = (target) => target') return undefined;
      evaluations += 1;
      return pageData;
    },
    goto: async () => ({ status: () => 200 }),
    isClosed: () => pageCloses > 0,
    locator: () => ({
      filter: () => ({ count: async () => 0, click: async () => undefined }),
    }),
    url: () => pageData.url,
    waitForTimeout: async () => undefined,
  };
  const client = createHltvClientWithBrowser({
    newPage: async () => page,
    close: async () => { browserCloses += 1; },
  } as unknown as HltvBrowserAdapter, { minRequestIntervalMs: 0 });

  const result = await client.getCompletedMatchStats(pageData.url);

  assert.equal(result.data.schemaVersion, '1.0.0');
  assert.equal(result.data.match.id, 2395903);
  assert.equal(result.data.availability, 'available');
  assert.deepEqual(
    result.data.matchStats.views.map((view) => [view.map, view.side]),
    [[null, 'both'], ['Ancient', 'ct'], ['Ancient', 't']],
  );
  assert.equal(result.data.matchStats.views[0]!.teams[0]!.players[0]!.rating, 1.2);
  assert.equal(result.diagnostics.operation, 'completed-match-stats');
  assert.equal(result.diagnostics.warnings.length, 0);
  assert.ok(evaluations >= 2);
  assert.equal(pageCloses, 1);

  await client.close();
  assert.equal(browserCloses, 1);
});

test('rejects a non-completed page from the completed Match stats API', async () => {
  const pageData = completedStatsPage();
  pageData.match.status = 'LIVE';
  let pageCloses = 0;
  const page = {
    addInitScript: async () => undefined,
    close: async () => { pageCloses += 1; },
    evaluate: async (expression: string | (() => unknown)) =>
      expression === 'globalThis.__name = (target) => target' ? undefined : pageData,
    goto: async () => ({ status: () => 200 }),
    isClosed: () => pageCloses > 0,
    locator: () => ({
      filter: () => ({ count: async () => 0, click: async () => undefined }),
    }),
    url: () => pageData.url,
    waitForTimeout: async () => undefined,
  };
  const client = createHltvClientWithBrowser({
    newPage: async () => page,
    close: async () => undefined,
  } as unknown as HltvBrowserAdapter, { minRequestIntervalMs: 0 });

  await assert.rejects(
    client.getCompletedMatchStats(pageData.url),
    (error: unknown) =>
      error instanceof HltvError
      && error.code === 'INVALID_INPUT'
      && error.operation === 'completed-match-stats',
  );
  assert.equal(pageCloses, 1);
  await client.close();
});

test('reads the complete virtual Game log from rendered component state without scrolling', async () => {
  const element = (
    type: string,
    className: string,
    children: unknown,
    props: Record<string, unknown> = {},
  ): Record<string, unknown> => ({ type, props: { ...props, className, children } });
  const formattedLines = [
    {
      render: element('div', 'winnerCT gamelogBox', [
        'Round over - Winner: ',
        element('span', 'ctplayer', 'CT'),
        ' (',
        element('span', 'tplayer', '1'),
        ' - ',
        element('span', 'ctplayer', '2'),
        ') - ',
        element('span', 'ctplayer', 'Enemy eliminated'),
      ]),
    },
    {
      render: element('div', 'playerKill gamelogBox', [
        element('span', 'ctplayer', 'alice'),
        ' killed ',
        element('span', 'tplayer', 'bob'),
        ' with ',
        element('img', 'playerWeapon', null, { src: '/weapons/ak47.png', alt: 'ak47' }),
        ' ',
        element('img', 'headshotIcon', null, { alt: '(headshot)' }),
      ]),
    },
    { render: element('div', 'roundStart gamelogBox', 'Round started') },
    { render: element('div', 'emptyRow', null) },
  ];
  const list = {
    scrollHeight: formattedLines.length * 26,
    __reactInternalInstance$test: {
      _currentElement: {
        _owner: {
          _instance: { formattedLines },
        },
      },
    },
  };
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelector: () => list },
  });
  try {
    const page = {
      evaluate: async (callback: () => unknown) => await callback(),
    } as unknown as Parameters<typeof extractFullGameLog>[0];
    const result = await extractFullGameLog(page);
    assert.equal(result.positionsVisited, 0);
    assert.deepEqual(result.chronological.map((event) => event.text), [
      'Round started',
      'alice killed bob with ak47 (headshot)',
      'Round over - Winner: CT (1 - 2) - Enemy eliminated',
    ]);
    assert.deepEqual(result.chronological[1], {
      top: 26,
      type: ['playerKill'],
      text: 'alice killed bob with ak47 (headshot)',
      players: [{ name: 'alice', side: 'CT' }, { name: 'bob', side: 'T' }],
      weapon: 'ak47',
      headshot: true,
    });
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete (globalThis as { document?: unknown }).document;
  }
});

test('waits for a complete Game log, then keeps one match page open and reuses it', async () => {
  const pageData: RawExtractedPage = {
    title: 'Alpha vs Bravo',
    url: 'https://www.hltv.org/matches/2395901/alpha-vs-bravo-event',
    match: {
      id: 2395901,
      status: 'LIVE',
      scheduledUnixMs: 1_784_000_000_000,
      event: { id: 1, name: 'Event', url: 'https://www.hltv.org/events/1/event' },
    },
    teams: [
      { id: 1, name: 'Alpha', url: null, country: null, logo: null },
      { id: 2, name: 'Bravo', url: null, country: null, logo: null },
    ],
    maps: {
      format: 'Best of 1',
      stage: 'Group stage',
      veto: [],
      maps: [{
        name: 'Dust2',
        optional: false,
        halfScores: '',
        teams: [
          { name: 'Alpha', score: '-', picked: false },
          { name: 'Bravo', score: '-', picked: false },
        ],
      }],
    },
    streams: [],
    lineups: [],
    mapStats: null,
    recentMatches: [],
    headToHead: null,
    sections: { matchPage: true, maps: true, scoreboard: true, gameLog: true },
  };
  const players = Array.from({ length: 5 }, (_, index) => ({
    player: `player-${index}`,
    cells: [],
  }));
  const scoreboard: RawScoreboard = {
    mode: 'Normal',
    round: '2 - Dust2',
    fact: '',
    score: '1:0',
    teams: [
      { team: 'Alpha', players },
      { team: 'Bravo', players },
    ],
  };
  const log = {
    scrollHeight: 400,
    chronological: [
      { top: 2, type: [], text: 'Round started', players: [], weapon: null, headshot: false },
      { top: 1, type: [], text: 'Round over - Winner: CT (1 - 0) - Enemy eliminated', players: [], weapon: null, headshot: false },
    ] satisfies RawLogEvent[],
    positionsVisited: 2,
  };
  const partialLog = {
    scrollHeight: 400,
    chronological: [
      { top: 2, type: [], text: 'Round started', players: [], weapon: null, headshot: false },
    ] satisfies RawLogEvent[],
    positionsVisited: 1,
  };
  let newPageCalls = 0;
  let closeCalls = 0;
  let logReads = 0;
  const page = {
    addInitScript: async () => undefined,
    goto: async () => ({ status: () => 200 }),
    url: () => pageData.url,
    isClosed: () => closeCalls > 0,
    close: async () => { closeCalls += 1; },
    waitForTimeout: async () => undefined,
    locator: () => ({
      filter: () => ({ count: async () => 0, click: async () => undefined }),
    }),
    evaluate: async (expression: string | (() => unknown)) => {
      if (typeof expression === 'function') {
        if (expression.toString().includes('dynamicText')) {
          return {
            present: true,
            score: '1:0',
            round: '2 - Dust2',
            teamNames: ['Alpha', 'Bravo'],
            playerRows: 10,
            scrollHeight: 400,
            visibleLogRows: 2,
            signature: 'steady-scorebot-state',
          };
        }
        logReads += 1;
        return logReads === 1 ? partialLog : log;
      }
      if (expression === 'globalThis.__name = (target) => target') return undefined;
      if (expression.includes('const requestedMode =')) return true;
      if (expression.includes('dynamicText')) {
        return {
          present: true,
          score: '1:0',
          round: '2 - Dust2',
          teamNames: ['Alpha', 'Bravo'],
          playerRows: 10,
          scrollHeight: 400,
          visibleLogRows: 2,
          signature: 'steady-scorebot-state',
        };
      }
      if (expression.includes("mode: clean(root.querySelector('.pro-toggle.active')")) {
        return scoreboard;
      }
      return pageData;
    },
  };
  const browser = {
    newPage: async () => {
      newPageCalls += 1;
      return page;
    },
  } as unknown as HltvBrowserAdapter;
  const session = new MatchCaptureSession(browser, {
    id: 2395901,
    slug: 'alpha-vs-bravo-event',
    url: pageData.url,
    pageReadyTimeoutMs: 1_000,
    scorebotReadyTimeoutMs: 1_000,
  });
  const firstContext = createOperationContext('match-detail', { timeoutMs: 5_000 }, 5_000);
  const secondContext = createOperationContext('match-detail', { timeoutMs: 5_000 }, 5_000);
  try {
    const first = await session.capture(firstContext, 1);
    const second = await session.capture(secondContext, 1);
    assert.equal(newPageCalls, 1);
    assert.equal(closeCalls, 0);
    assert.equal(first.session?.reused, false);
    assert.equal(first.session?.snapshotCacheHit, false);
    assert.equal(second.session?.reused, true);
    assert.equal(second.session?.snapshotCacheHit, true);
    assert.equal(second.timings?.navigationMs, 0);
    assert.equal(logReads, 2);
    assert.notEqual(first.snapshot, second.snapshot);
    assert.equal(second.snapshot.capturedAt, second.completedAt);
  } finally {
    firstContext.dispose();
    secondContext.dispose();
    await session.close();
  }
  assert.equal(closeCalls, 1);
});

test('refreshes the persistent page once when Scorebot advances to the next map', async () => {
  const url = 'https://www.hltv.org/matches/2395739/alka-vs-borracheiros-event';
  const players = Array.from({ length: 5 }, (_, index) => ({
    player: `player-${index}`,
    cells: [],
  }));
  const rounds = (count: number): RawLogEvent[] => Array.from(
    { length: count },
    (_, index) => index + 1,
  ).flatMap((score) => [
    { top: score * 2, type: [], text: 'Round started', players: [], weapon: null, headshot: false },
    {
      top: score * 2 - 1,
      type: [],
      text: `Round over - Winner: CT (${score} - 0) - Enemy eliminated`,
      players: [],
      weapon: null,
      headshot: false,
    },
  ] satisfies RawLogEvent[]);
  const basePage = (): RawExtractedPage => ({
    title: 'ALKA vs Borracheiros',
    url,
    match: {
      id: 2395739,
      status: 'LIVE',
      scheduledUnixMs: 1_784_000_000_000,
      event: { id: 1, name: 'Event', url: 'https://www.hltv.org/events/1/event' },
    },
    teams: [
      { id: 1, name: 'ALKA', url: null, country: null, logo: null },
      { id: 2, name: 'Borracheiros', url: null, country: null, logo: null },
    ],
    maps: {
      format: 'Best of 3',
      stage: 'Group stage',
      veto: [],
      maps: [
        { name: 'Ancient', optional: false, halfScores: '', teams: [
          { name: 'ALKA', score: '-', picked: true },
          { name: 'Borracheiros', score: '-', picked: false },
        ] },
        { name: 'Inferno', optional: false, halfScores: '', teams: [
          { name: 'ALKA', score: '-', picked: false },
          { name: 'Borracheiros', score: '-', picked: true },
        ] },
        { name: 'Nuke', optional: true, halfScores: '', teams: [
          { name: 'ALKA', score: '-', picked: false },
          { name: 'Borracheiros', score: '-', picked: false },
        ] },
      ],
    },
    streams: [],
    lineups: [],
    mapStats: null,
    recentMatches: [],
    headToHead: null,
    sections: { matchPage: true, maps: true, scoreboard: true, gameLog: true },
  });
  let map: 'Ancient' | 'Inferno' = 'Ancient';
  let gotoCalls = 0;
  let closeCalls = 0;
  const currentPage = (): RawExtractedPage => {
    const page = basePage();
    if (map === 'Inferno') {
      page.maps.maps[0]!.teams[0]!.score = '2';
      page.maps.maps[0]!.teams[1]!.score = '13';
    }
    return page;
  };
  const currentScoreboard = (): RawScoreboard => ({
    mode: 'Normal',
    round: map === 'Ancient' ? '16 - Ancient' : '2 - Inferno',
    fact: '',
    score: map === 'Ancient' ? '2:13' : '1:0',
    teams: [
      { team: 'ALKA', side: 'CT', players },
      { team: 'Borracheiros', side: 'T', players },
    ],
  });
  const currentLog = () => {
    const chronological = map === 'Ancient' ? rounds(15) : rounds(1);
    return {
      scrollHeight: chronological.length * 26,
      chronological,
      positionsVisited: 0,
    };
  };
  const page = {
    addInitScript: async () => undefined,
    goto: async () => {
      gotoCalls += 1;
      return { status: () => 200 };
    },
    url: () => url,
    isClosed: () => closeCalls > 0,
    close: async () => { closeCalls += 1; },
    waitForTimeout: async () => undefined,
    locator: () => ({
      filter: () => ({ count: async () => 0, click: async () => undefined }),
    }),
    evaluate: async (expression: string | (() => unknown)) => {
      if (typeof expression === 'function') {
        if (expression.toString().includes('dynamicText')) {
          const scoreboard = currentScoreboard();
          const log = currentLog();
          return {
            present: true,
            score: scoreboard.score,
            round: scoreboard.round,
            teamNames: scoreboard.teams.map((team) => team.team),
            playerRows: 10,
            scrollHeight: log.scrollHeight,
            visibleLogRows: log.chronological.length,
            signature: `${map}-${scoreboard.score}`,
          };
        }
        return currentLog();
      }
      if (expression === 'globalThis.__name = (target) => target') return undefined;
      if (expression.includes('const requestedMode =')) return true;
      if (expression.includes('dynamicText')) {
        const scoreboard = currentScoreboard();
        const log = currentLog();
        return {
          present: true,
          score: scoreboard.score,
          round: scoreboard.round,
          teamNames: scoreboard.teams.map((team) => team.team),
          playerRows: 10,
          scrollHeight: log.scrollHeight,
          visibleLogRows: log.chronological.length,
          signature: `${map}-${scoreboard.score}`,
        };
      }
      if (expression.includes("mode: clean(root.querySelector('.pro-toggle.active')")) {
        return currentScoreboard();
      }
      return currentPage();
    },
  };
  const browser = {
    newPage: async () => page,
  } as unknown as HltvBrowserAdapter;
  const session = new MatchCaptureSession(browser, {
    id: 2395739,
    slug: 'alka-vs-borracheiros-event',
    url,
    pageReadyTimeoutMs: 1_000,
    scorebotReadyTimeoutMs: 1_000,
  });
  const firstContext = createOperationContext('match-detail', { timeoutMs: 5_000 }, 5_000);
  const secondContext = createOperationContext('match-detail', { timeoutMs: 5_000 }, 5_000);
  try {
    const first = await session.capture(firstContext, 1);
    assert.equal(first.snapshot.scoreboardNormal?.round, '16 - Ancient');
    map = 'Inferno';
    const second = await session.capture(secondContext, 1);
    const result = buildConsumerFromCapture(second, []);

    assert.equal(gotoCalls, 2);
    assert.equal(second.session?.reused, true);
    assert.equal(second.session?.snapshotCacheHit, false);
    assert.deepEqual(
      result.data.maps.map((item) => [item.name, item.status, item.score]),
      [
        ['Ancient', 'completed', [{ teamId: 1, score: 2 }, { teamId: 2, score: 13 }]],
        ['Inferno', 'current', [{ teamId: 1, score: 1 }, { teamId: 2, score: 0 }]],
        ['Nuke', 'upcoming', []],
      ],
    );
    assert.ok(result.diagnostics.warnings.some((warning) =>
      warning.code === 'INCOMPLETE_GAME_LOG'
      && warning.map === 'Ancient'
      && warning.expectedCompletedRounds === 15));
  } finally {
    firstContext.dispose();
    secondContext.dispose();
    await session.close();
  }
  assert.equal(closeCalls, 1);
});

test('preserves bounded attempt evidence on a terminal HLTV error', () => {
  const error = new HltvError('scorebot unavailable', {
    code: 'INCOMPLETE_CAPTURE',
    operation: 'match-detail',
    stage: 'extracting-scorebot',
    retryable: false,
    matchId: 2395900,
    details: { httpStatus: 200 },
  });
  const attempts = [{
    attempt: 1,
    startedAt: '2026-07-14T00:00:00.000Z',
    completedAt: '2026-07-14T00:00:30.000Z',
    httpStatus: 200,
    error: { code: 'INCOMPLETE_CAPTURE', message: 'scorebot unavailable' },
  }];

  const enriched = withHltvErrorDetails(error, { attempts });

  assert.equal(enriched.code, error.code);
  assert.equal(enriched.stage, error.stage);
  assert.equal(enriched.matchId, error.matchId);
  assert.equal(enriched.details?.httpStatus, 200);
  assert.deepEqual(enriched.details?.attempts, attempts);
});

test('accepts complete completed-match data', () => {
  const match = cloneFixture();
  validateMatch(match, diagnosticsFor(match), rawSections, match.match.id);
  assert.equal(match.maps.flatMap((map) => map.gameLog.rounds).length, 42);
  assert.equal(match.players.length, 10);
});

test('accepts upcoming-match absence without inventing data', () => {
  const match = cloneFixture();
  match.match.status = 'Starts in 1 hour';
  match.current = null;
  match.maps = match.maps.map((map): MatchMap => ({
    ...map,
    status: 'upcoming',
    score: [],
    halves: [],
    scoreboard: null,
    gameLog: { rounds: [] },
  }));
  validateMatch(match, diagnosticsFor(match), rawSections, match.match.id);
});

test('accepts a live map with completed rounds and a current snapshot', () => {
  const match = cloneFixture();
  const liveMap = match.maps[0]!;
  liveMap.status = 'current';
  liveMap.scoreboard = null;
  match.maps = [liveMap, ...match.maps.slice(1).map((map): MatchMap => ({
    ...map,
    status: 'upcoming',
    score: [],
    halves: [],
    scoreboard: null,
    gameLog: { rounds: [] },
  }))];
  match.match.status = 'LIVE';
  match.current = {
    capturedAt: match.capturedAt,
    map: liveMap.name,
    round: liveMap.gameLog.rounds.length + 1,
    score: liveMap.score,
    scoreboard: null,
  };
  validateMatch(match, diagnosticsFor(match), rawSections, match.match.id);
});

test('normalizes Match stats across map, side, and eco-adjusted dimensions', () => {
  const capturedAt = '2026-07-14T00:00:00.000Z';
  const player = (id: number, nickname: string) => ({
    id,
    nickname,
    fullName: nickname,
    country: null,
    image: null,
    profileUrl: null,
    statsUrl: null,
    rating: null,
    kpr: null,
    dpr: null,
    kast: null,
    adr: null,
    stats: {},
  });
  const metricPlayer = (
    id: number,
    nickname: string,
    kills: string,
    deaths: string,
  ) => ({
    id,
    nickname,
    kills,
    deaths,
    ecoAdjustedKills: String(Number(kills) + 1),
    ecoAdjustedDeaths: String(Number(deaths) - 1),
    roundSwing: '+2.50%',
    adr: '80.5',
    ecoAdjustedAdr: '82.1',
    kast: '75.0%',
    ecoAdjustedKast: '77.5%',
    rating: '1.20',
  });
  const page: RawExtractedPage = {
    title: 'Alpha vs Bravo',
    url: 'https://www.hltv.org/matches/2395900/alpha-vs-bravo-event',
    match: {
      id: 2395900,
      status: 'Starts in 1 hour',
      scheduledUnixMs: 1_784_000_000_000,
      event: { id: 1, name: 'Event', url: 'https://www.hltv.org/events/1/event' },
    },
    teams: [
      { id: 1, name: 'Alpha', url: null, country: null, logo: null },
      { id: 2, name: 'Bravo', url: null, country: null, logo: null },
    ],
    maps: { format: 'Best of 3', stage: 'Group stage', veto: [], maps: [] },
    streams: [],
    lineups: [
      { id: 1, name: 'Alpha', worldRank: 1, players: [player(11, 'alpha-one')] },
      { id: 2, name: 'Bravo', worldRank: 2, players: [player(21, 'bravo-one')] },
    ],
    matchStats: {
      views: [
        {
          mapStatsId: null,
          map: null,
          side: 'both',
          teams: [
            { id: 1, name: 'Alpha', players: [metricPlayer(11, 'alpha-one', '10', '8')] },
            {
              id: 2,
              name: 'Bravo',
              players: [
                metricPlayer(21, 'bravo-one', '9', '10'),
                metricPlayer(22, 'bravo-substitute', '3', '4'),
              ],
            },
          ],
        },
        {
          mapStatsId: 232821,
          map: 'Cache',
          side: 'ct',
          teams: [
            { id: 1, name: 'Alpha', players: [metricPlayer(11, 'alpha-one', '6', '3')] },
            { id: 2, name: 'Bravo', players: [metricPlayer(21, 'bravo-one', '4', '5')] },
          ],
        },
        {
          mapStatsId: 232821,
          map: 'Cache',
          side: 't',
          teams: [
            { id: 1, name: 'Alpha', players: [metricPlayer(11, 'alpha-one', '4', '5')] },
            { id: 2, name: 'Bravo', players: [metricPlayer(21, 'bravo-one', '5', '5')] },
          ],
        },
      ],
    },
    mapStats: null,
    recentMatches: [],
    headToHead: null,
    sections: { matchPage: true, maps: true, matchStats: true },
  };
  const capture: CaptureAttempt = {
    initialPage: page,
    snapshot: {
      capturedAt,
      httpStatus: 200,
      page,
      scoreboardNormal: null,
      scoreboardAdvanced: null,
      gameLog: { scrollHeight: 0, chronological: [], excludedNoiseEvents: 0 },
      note: null,
    },
    collector: {
      packageVersion: '0.0.0',
      cloakbrowserVersion: '0.4.10',
      playwrightVersion: '1.61.0',
    },
    httpStatus: 200,
    navigationSeconds: 0,
    totalSeconds: 0,
    attempt: 1,
    startedAt: capturedAt,
    completedAt: capturedAt,
  };

  const result = buildConsumerFromCapture(capture, []);

  assert.equal(result.data.schemaVersion, '3.2.0');
  assert.equal(result.data.matchStats.views.length, 3);
  assert.deepEqual(result.data.matchStats.views.map((view) => [view.map, view.side]), [
    [null, 'both'],
    ['Cache', 'ct'],
    ['Cache', 't'],
  ]);
  assert.deepEqual(result.data.matchStats.views[0]!.teams[0]!.players[0], {
    playerId: 11,
    nickname: 'alpha-one',
    traditional: { kills: 10, deaths: 8, adr: 80.5, kastRate: 0.75 },
    ecoAdjusted: { kills: 11, deaths: 7, adr: 82.1, kastRate: 0.775 },
    roundSwingRate: 0.025,
    rating: 1.2,
  });
  assert.deepEqual(result.data.players.find((item) => item.id === 22), {
    id: 22,
    nickname: 'bravo-substitute',
    fullName: null,
    country: null,
    image: null,
    bodyshotUrl: null,
    profileUrl: null,
    statsUrl: null,
    metrics: {
      rating: null,
      killsPerRound: null,
      deathsPerRound: null,
      kastRate: null,
      adr: null,
      multiKillRating: null,
      roundSwingRate: null,
    },
  });

  page.matchStats = null;
  const withoutMatchStats = buildConsumerFromCapture(capture, []);
  assert.deepEqual(withoutMatchStats.data.matchStats, { views: [] });
});

test('rejects score and Game log disagreement', () => {
  const match = cloneFixture();
  match.maps[0]!.score[0]!.score += 1;
  assert.throws(
    () => validateMatch(match, diagnosticsFor(match), rawSections, match.match.id),
    (error: unknown) => error instanceof HltvError && error.code === 'INCOMPLETE_CAPTURE',
  );
});

test('keeps an anonymous stand-in assigned to its explicit lineup team', () => {
  const capturedAt = '2026-07-15T21:29:41.599Z';
  const page = completedStatsPage();
  page.match.status = 'LIVE';
  page.matchStats = null;
  for (const team of page.maps.maps[0]!.teams) team.score = '-';
  const standIn = page.lineups[1]!.players[0]!;
  standIn.id = null;
  standIn.nickname = 'reset';
  const scoreboard: RawScoreboard = {
    mode: 'Normal',
    round: '2 - Ancient',
    fact: '',
    score: '0:1',
    teams: [
      { team: 'Alpha', side: 'CT', players: [] },
      { team: 'Bravo', side: 'T', players: [] },
    ],
  };
  const capture: CaptureAttempt = {
    initialPage: page,
    snapshot: {
      capturedAt,
      httpStatus: 200,
      page,
      scoreboardNormal: scoreboard,
      scoreboardAdvanced: null,
      gameLog: {
        scrollHeight: 100,
        chronological: [
          { top: 30, type: [], text: 'Round started', players: [], weapon: null, headshot: false },
          {
            top: 20,
            type: ['playerKill'],
            text: 'reset killed alpha-one',
            players: [
              { name: 'reset', side: 'T' },
              { name: 'alpha-one', side: 'CT' },
            ],
            weapon: 'ak47',
            headshot: false,
          },
          {
            top: 10,
            type: [],
            text: 'Round over - Winner: T (0 - 1) - Enemy eliminated',
            players: [],
            weapon: null,
            headshot: false,
          },
        ],
        excludedNoiseEvents: 0,
      },
      note: null,
    },
    collector: {
      packageVersion: '0.0.0',
      cloakbrowserVersion: '0.4.10',
      playwrightVersion: '1.61.0',
    },
    httpStatus: 200,
    navigationSeconds: 0,
    totalSeconds: 0,
    attempt: 1,
    startedAt: capturedAt,
    completedAt: capturedAt,
  };

  const result = buildConsumerFromCapture(capture, []);

  assert.deepEqual(result.data.lineups[1], {
    teamId: 2,
    worldRank: 2,
    playerIds: [],
    players: [{ playerId: null, nickname: 'reset' }],
  });
  assert.equal(result.data.players.some((player) => player.nickname === 'reset'), false);
  assert.deepEqual(result.data.maps[0]!.gameLog.rounds[0]!.events[0]!.players, [
    { playerId: null, nickname: 'reset', teamId: 2, side: 'T' },
    { playerId: 11, teamId: 1, side: 'CT' },
  ]);
  assert.deepEqual(result.data.maps[0]!.gameLog.rounds[0]!.result, {
    winnerSide: 'T',
    winnerTeamId: 2,
    teamScore: [{ teamId: 1, score: 0 }, { teamId: 2, score: 1 }],
    sideScore: { ct: 0, t: 1 },
    reason: 'Enemy eliminated',
  });
  assert.ok(result.diagnostics.warnings.some((warning) =>
    warning.code === 'UNIDENTIFIED_LINEUP_PLAYER'
    && warning.teamId === 2
    && warning.nickname === 'reset'));
  assert.doesNotThrow(() =>
    validateMatch(result.data, result.diagnostics, page, result.data.match.id));
});

test('rejects an anonymous lineup nickname assigned to both teams', () => {
  const match = cloneFixture();
  match.lineups[0]!.players = [
    ...match.lineups[0]!.playerIds.map((playerId) => ({
      playerId,
      nickname: match.players.find((player) => player.id === playerId)!.nickname,
    })),
    { playerId: null, nickname: 'stand-in' },
  ];
  match.lineups[1]!.players = [
    ...match.lineups[1]!.playerIds.map((playerId) => ({
      playerId,
      nickname: match.players.find((player) => player.id === playerId)!.nickname,
    })),
    { playerId: null, nickname: 'stand-in' },
  ];

  assert.throws(
    () => validateMatch(match, diagnosticsFor(match), rawSections, match.match.id),
    /lineup nickname belongs to more than one team/,
  );
});

test('rejects a winning team that disagrees with the round participants', () => {
  const match = cloneFixture();
  const result = match.maps
    .flatMap((map) => map.gameLog.rounds)
    .find((round) => round.result?.winnerTeamId !== null)?.result;
  assert.ok(result?.winnerTeamId);
  result.winnerTeamId = match.teams.find((team) => team.id !== result.winnerTeamId)!.id;

  assert.throws(
    () => validateMatch(match, diagnosticsFor(match), rawSections, match.match.id),
    /inconsistent winning team/,
  );
});

test('accepts an explicitly diagnosed historical Game log gap', () => {
  const match = cloneFixture();
  const historicalMap = match.maps[0]!;
  historicalMap.gameLog.rounds = [];
  const diagnostics = diagnosticsFor(match);
  diagnostics.warnings.push({
    code: 'INCOMPLETE_GAME_LOG',
    map: historicalMap.name,
    expectedCompletedRounds: diagnostics.mapChecks[historicalMap.name]!.scoreSum,
    capturedCompletedRounds: 0,
    reason: 'The Scorebot session started after this map finished.',
  });

  assert.doesNotThrow(() =>
    validateMatch(match, diagnostics, rawSections, match.match.id));
});

test('rejects a historical Game log warning whose evidence does not match the map check', () => {
  const match = cloneFixture();
  const historicalMap = match.maps[0]!;
  historicalMap.gameLog.rounds = [];
  const diagnostics = diagnosticsFor(match);
  diagnostics.warnings.push({
    code: 'INCOMPLETE_GAME_LOG',
    map: historicalMap.name,
    expectedCompletedRounds: diagnostics.mapChecks[historicalMap.name]!.scoreSum + 1,
    capturedCompletedRounds: 0,
  });

  assert.throws(
    () => validateMatch(match, diagnostics, rawSections, match.match.id),
    (error: unknown) => error instanceof HltvError && error.code === 'INCOMPLETE_CAPTURE',
  );
});

test('rejects Match stats that reference an unknown player', () => {
  const match = cloneFixture();
  match.matchStats = {
    views: [{
      mapStatsId: null,
      map: null,
      side: 'both',
      teams: [{
        teamId: match.teams[0]!.id,
        name: match.teams[0]!.name,
        players: [{
          playerId: 999_999,
          nickname: 'unknown',
          traditional: { kills: 1, deaths: 1, adr: 50, kastRate: 0.5 },
          ecoAdjusted: { kills: 1, deaths: 1, adr: 50, kastRate: 0.5 },
          roundSwingRate: 0,
          rating: 1,
        }],
      }],
    }],
  };

  assert.throws(
    () => validateMatch(match, diagnosticsFor(match), rawSections, match.match.id),
    (error: unknown) => error instanceof HltvError && error.code === 'INCOMPLETE_CAPTURE',
  );
});

test('returns a warning-bearing partial snapshot when Scorebot is unavailable between maps', () => {
  const capturedAt = '2026-07-14T15:09:49.336Z';
  const page: RawExtractedPage = {
    title: 'BIG Academy vs ex-MANA',
    url: 'https://www.hltv.org/matches/2395891/big-academy-vs-ex-mana-event',
    match: {
      id: 2395891,
      status: 'LIVE',
      scheduledUnixMs: 1_784_000_000_000,
      event: { id: 1, name: 'Event', url: 'https://www.hltv.org/events/1/event' },
    },
    teams: [
      { id: 10254, name: 'BIG Academy', url: null, country: null, logo: null },
      { id: 13892, name: 'ex-MANA', url: null, country: null, logo: null },
    ],
    maps: {
      format: 'Best of 3',
      stage: 'Group stage',
      veto: [],
      maps: [
        { name: 'Ancient', optional: false, halfScores: '', teams: [
          { name: 'BIG Academy', score: '16', picked: true },
          { name: 'ex-MANA', score: '14', picked: false },
        ] },
        { name: 'Dust2', optional: false, halfScores: '', teams: [
          { name: 'BIG Academy', score: '-', picked: false },
          { name: 'ex-MANA', score: '-', picked: true },
        ] },
        { name: 'Mirage', optional: false, halfScores: '', teams: [
          { name: 'BIG Academy', score: '-', picked: false },
          { name: 'ex-MANA', score: '-', picked: false },
        ] },
      ],
    },
    streams: [],
    lineups: [],
    mapStats: null,
    recentMatches: [],
    headToHead: null,
    sections: { matchPage: true, maps: true, scoreboard: false, gameLog: false },
  };
  const capture: CaptureAttempt = {
    initialPage: page,
    snapshot: {
      capturedAt,
      httpStatus: 200,
      page,
      scoreboardNormal: null,
      scoreboardAdvanced: null,
      gameLog: { scrollHeight: 0, chronological: [], excludedNoiseEvents: 0 },
      note: 'Scorebot was not present for this match state.',
    },
    collector: {
      packageVersion: '0.0.0',
      cloakbrowserVersion: '0.4.10',
      playwrightVersion: '1.61.0',
    },
    httpStatus: 200,
    navigationSeconds: 1,
    totalSeconds: 31,
    attempt: 1,
    startedAt: capturedAt,
    completedAt: capturedAt,
  };

  const result = buildConsumerFromCapture(capture, []);

  assert.equal(result.data.current, null);
  assert.deepEqual(
    result.data.maps.map((map) => [map.name, map.status, map.score]),
    [
      ['Ancient', 'completed', [{ teamId: 10254, score: 16 }, { teamId: 13892, score: 14 }]],
      ['Dust2', 'upcoming', []],
      ['Mirage', 'upcoming', []],
    ],
  );
  assert.ok(result.diagnostics.warnings.some((warning) => warning.code === 'SCOREBOT_UNAVAILABLE'));
  assert.equal(result.diagnostics.mapChecks.Ancient?.consistent, false);
  validateMatch(result.data, result.diagnostics, page, 2395891);

  const skeletonCapture = structuredClone(capture);
  skeletonCapture.snapshot.scoreboardNormal = {
    mode: 'Normal',
    round: '',
    fact: '',
    score: '',
    teams: [
      { team: '', players: [] },
      { team: '', players: [] },
    ],
  };
  const skeleton = buildConsumerFromCapture(skeletonCapture, []);
  assert.equal(skeleton.data.current, null);
  assert.equal(
    (skeleton.diagnostics.capture.scorebot as { scoreboardPresent?: boolean }).scoreboardPresent,
    false,
  );
  assert.ok(skeleton.diagnostics.warnings.some((warning) => warning.code === 'SCOREBOT_UNAVAILABLE'));
  validateMatch(skeleton.data, skeleton.diagnostics, page, 2395891);
});

test('reconciles overlapping Scorebot replay fragments across maps', () => {
  let top = 0;
  const event = (text: string): RawLogEvent => ({
    top: top++,
    type: [],
    text,
    players: [],
    weapon: null,
    headshot: false,
  });
  const scoredRounds = (start: number, end: number, correctedReplay = false): RawLogEvent[] => Array.from(
    { length: end - start + 1 },
    (_, index) => start + index,
  ).flatMap((total) => {
    const corrected = correctedReplay && total > start;
    return [
      event('Round started'),
      event(`Round over - Winner: ${corrected ? 'T' : 'CT'} (${corrected ? total - 1 : total} - ${corrected ? 1 : 0}) - Enemy eliminated`),
    ];
  });
  const terroristRounds = (start: number, end: number): RawLogEvent[] => Array.from(
    { length: end - start + 1 },
    (_, index) => start + index,
  ).flatMap((total) => [
    event('Round started'),
    event(`Round over - Winner: T (${total} - 0) - Enemy eliminated`),
  ]);
  const knifeRound = (): RawLogEvent[] => [
    event('Round started'),
    event('Round over - Winner: CT (1 - 0) - Enemy eliminated'),
  ];
  const drawRound = (): RawLogEvent[] => [
    event('Round started'),
    event('Round over - Draw'),
  ];

  const page: RawExtractedPage = {
    title: 'Alpha vs Bravo',
    url: 'https://www.hltv.org/matches/2395805/alpha-vs-bravo-event',
    match: {
      id: 2395805,
      status: 'LIVE',
      scheduledUnixMs: 1_784_000_000_000,
      event: { id: 1, name: 'Event', url: 'https://www.hltv.org/events/1/event' },
    },
    teams: [
      { id: 1, name: 'Alpha', url: null, country: null, logo: null },
      { id: 2, name: 'Bravo', url: null, country: null, logo: null },
    ],
    maps: {
      format: 'Best of 3',
      stage: 'Group stage',
      veto: [],
      maps: [
        { name: 'Dust2', optional: false, halfScores: '', teams: [
          { name: 'Alpha', score: '25', picked: true },
          { name: 'Bravo', score: '22', picked: false },
        ] },
        { name: 'Mirage', optional: false, halfScores: '', teams: [
          { name: 'Alpha', score: '13', picked: false },
          { name: 'Bravo', score: '5', picked: true },
        ] },
        { name: 'Nuke', optional: false, halfScores: '', teams: [
          { name: 'Alpha', score: '-', picked: false },
          { name: 'Bravo', score: '-', picked: false },
        ] },
      ],
    },
    streams: [],
    lineups: [],
    mapStats: null,
    recentMatches: [],
    headToHead: null,
    sections: { matchPage: true, maps: true },
  };
  const scoreboard: RawScoreboard = {
    mode: 'Normal',
    round: '8 - Nuke',
    fact: '',
    score: '4:3',
    teams: [
      { team: 'Alpha', side: 'CT', players: [] },
      { team: 'Bravo', side: 'T', players: [] },
    ],
  };
  const chronological = [
    ...knifeRound(),
    ...scoredRounds(1, 28),
    ...knifeRound(),
    ...drawRound(),
    ...scoredRounds(24, 47, true),
    ...knifeRound(),
    ...terroristRounds(1, 18),
    ...knifeRound(),
    ...scoredRounds(1, 7),
  ];
  const capturedAt = '2026-07-13T00:00:00.000Z';
  const capture: CaptureAttempt = {
    initialPage: page,
    snapshot: {
      capturedAt,
      httpStatus: 200,
      page,
      scoreboardNormal: scoreboard,
      scoreboardAdvanced: null,
      gameLog: { scrollHeight: chronological.length * 26, chronological, excludedNoiseEvents: 0 },
      note: null,
    },
    collector: { packageVersion: '0.0.0', cloakbrowserVersion: '0.4.10', playwrightVersion: '1.61.0' },
    httpStatus: 200,
    navigationSeconds: 0,
    totalSeconds: 0,
    attempt: 1,
    startedAt: capturedAt,
    completedAt: capturedAt,
  };

  const result = buildConsumerFromCapture(capture, [{
    attempt: 1,
    startedAt: capturedAt,
    completedAt: capturedAt,
    httpStatus: 200,
  }]);

  assert.deepEqual(
    result.data.maps.map((map) => [map.name, map.gameLog.rounds.filter((round) => round.result).length]),
    [['Dust2', 47], ['Mirage', 18], ['Nuke', 7]],
  );
  assert.deepEqual(result.data.maps[0]!.gameLog.rounds[24]!.result?.sideScore, { ct: 24, t: 1 });
  assert.deepEqual(
    result.data.current?.scoreboard?.teams.map((team) => [team.teamId, team.side]),
    [[1, 'CT'], [2, 'T']],
  );
  assert.deepEqual(result.data.maps[1]!.gameLog.rounds[0]!.result, {
    winnerSide: 'T',
    winnerTeamId: null,
    teamScore: null,
    sideScore: { ct: 0, t: 1 },
    reason: 'Enemy eliminated',
  });
  validateMatch(result.data, result.diagnostics, page, 2395805);
});
