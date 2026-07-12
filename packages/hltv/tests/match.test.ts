import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { matchIdentityFromUrl, normalizeClientOptions } from '../src/config.js';
import { HltvError } from '../src/errors.js';
import { retryDelayMilliseconds } from '../src/runtime.js';
import { buildConsumerFromCapture } from '../src/transform/build_consumer.js';
import { validateMatch } from '../src/transform/validate_match.js';
import type {
  CaptureAttempt, HltvMatch, MatchDiagnostics, MatchMap, RawExtractedPage, RawLogEvent, RawScoreboard,
} from '../src/types.js';

const fixturePath = resolve(
  import.meta.dirname,
  'fixtures/completed-match.json',
);
const completedFixture = JSON.parse(await readFile(fixturePath, 'utf8')) as HltvMatch;
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
  assert.equal(
    normalizeClientOptions().timezone,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  assert.equal(
    normalizeClientOptions({ timezone: 'America/Los_Angeles' }).timezone,
    'America/Los_Angeles',
  );
});

test('uses a longer bounded cooldown for an access challenge', () => {
  assert.equal(retryDelayMilliseconds('ACCESS_BLOCKED', 1, 0), 10_000);
  assert.equal(retryDelayMilliseconds('ACCESS_BLOCKED', 1, 0.999_999), 12_500);
  assert.equal(retryDelayMilliseconds('ACCESS_BLOCKED', 2, 0), 20_000);
  assert.equal(retryDelayMilliseconds('ACCESS_BLOCKED', 2, 0.999_999), 25_000);
  assert.equal(retryDelayMilliseconds('NAVIGATION_FAILED', 1, 0), 2_000);
  assert.equal(retryDelayMilliseconds('NAVIGATION_FAILED', 1, 0.999_999), 2_500);
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

test('rejects score and Game log disagreement', () => {
  const match = cloneFixture();
  match.maps[0]!.score[0]!.score += 1;
  assert.throws(
    () => validateMatch(match, diagnosticsFor(match), rawSections, match.match.id),
    (error: unknown) => error instanceof HltvError && error.code === 'INCOMPLETE_CAPTURE',
  );
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
      { team: 'Alpha', players: [] },
      { team: 'Bravo', players: [] },
    ],
  };
  const chronological = [
    ...knifeRound(),
    ...scoredRounds(1, 28),
    ...knifeRound(),
    ...drawRound(),
    ...scoredRounds(24, 47, true),
    ...knifeRound(),
    ...scoredRounds(1, 18),
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
  validateMatch(result.data, result.diagnostics, page, 2395805);
});
