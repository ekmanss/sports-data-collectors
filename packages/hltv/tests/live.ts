import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import type { HltvBrowserAdapter, HltvPageAdapter } from '../src/browser_adapter.js';
import { matchIdentityFromUrl } from '../src/config.js';
import { HltvError } from '../src/errors.js';
import { createHltvClient, createHltvClientWithBrowser } from '../src/index.js';
import type {
  GetHltvCompletedMatchStatsResult,
  GetHltvLiveMatchesResult,
  GetHltvMatchResult,
} from '../src/types.js';

const matchUrl = process.env.HLTV_MATCH_URL;
if (!matchUrl) throw new Error('set HLTV_MATCH_URL to run the real-network smoke test');
const completedMatchUrl = process.env.HLTV_COMPLETED_MATCH_URL;
if (!completedMatchUrl) {
  throw new Error('set HLTV_COMPLETED_MATCH_URL to run the real-network smoke test');
}

const clientOptions = {
  ...(process.env.HLTV_TIMEZONE ? { timezone: process.env.HLTV_TIMEZONE } : {}),
  ...(process.env.HLTV_PROXY_SERVER ? {
    proxy: {
      server: process.env.HLTV_PROXY_SERVER,
      ...(process.env.HLTV_PROXY_USERNAME ? { username: process.env.HLTV_PROXY_USERNAME } : {}),
      ...(process.env.HLTV_PROXY_PASSWORD ? { password: process.env.HLTV_PROXY_PASSWORD } : {}),
    },
  } : {}),
};

const onProgress = (event: { stage: string; message: string }): void => {
  process.stderr.write(`[${event.stage}] ${event.message}\n`);
};

const delay = async (milliseconds: number): Promise<void> => await new Promise(
  (resolve) => setTimeout(resolve, milliseconds),
);
let live: GetHltvLiveMatchesResult | undefined;
let warmLive: GetHltvLiveMatchesResult | undefined;
let detail: GetHltvMatchResult | undefined;
let warmDetail: GetHltvMatchResult | undefined;
let completedStats: GetHltvCompletedMatchStatsResult | undefined;
for (let browserAttempt = 1; browserAttempt <= 3; browserAttempt += 1) {
  const client = await createLiveClient();
  try {
    live = await client.getLiveMatches({ onProgress });
    warmLive = await client.getLiveMatches({ onProgress });
    detail = await client.getMatch(matchUrl, { onProgress });
    warmDetail = await client.getMatch(matchUrl, { onProgress });
    completedStats = await client.getCompletedMatchStats(completedMatchUrl, { onProgress });
    break;
  } catch (error) {
    if (!(error instanceof HltvError)
      || error.code !== 'ACCESS_BLOCKED'
      || browserAttempt === 3) throw error;
    process.stderr.write(`[browser-rotation] Access blocked; retrying with a fresh client (${browserAttempt}/2)\n`);
  } finally {
    await client.close();
  }
  await delay(browserAttempt * 10_000);
}
if (!live || !warmLive || !detail || !warmDetail || !completedStats) {
  throw new Error('real-network smoke did not produce results');
}
assert.equal(live.data.schemaVersion, '1.0.0');
assert.equal(live.data.sport, 'cs2');
assert.equal(live.data.source.url, 'https://www.hltv.org/matches');
assert.equal(live.diagnostics.summary.matchesReturned, live.data.matches.length);
assert.ok(Number.isFinite(Date.parse(live.data.capturedAt)));
for (const match of live.data.matches) {
  assert.equal(match.status, 'live');
  assert.equal(matchIdentityFromUrl(match.url)?.id, match.id);
  assert.equal(match.teams.length, 2);
  assert.ok(match.teams.every((team) => team.name.length > 0));
}
assert.equal(live.diagnostics.capture?.session.reused, false);
assert.equal(live.diagnostics.capture?.session.navigated, true);
assert.equal(warmLive.diagnostics.capture?.session.reused, true);
assert.equal(warmLive.diagnostics.capture?.session.navigated, false);

assert.equal(detail.data.schemaVersion, '3.2.0');
assert.equal(detail.data.match.id, matchIdentityFromUrl(matchUrl)?.id);
assert.equal(detail.data.teams.length, 2);
assert.ok(detail.data.maps.length > 0);
for (const view of detail.data.recentMatches.views) {
  for (const team of view.teams) {
    for (const match of team.matches) {
      assert.ok(
        match.match.id !== null
          || match.match.url !== null
          || match.opponent.id !== null
          || match.opponent.name.trim().length > 0
          || match.opponent.url !== null
          || match.timeAgo !== null
          || match.format.trim().length > 0
          || match.score !== null
          || match.result !== null,
        'Recent matches must not contain HLTV empty-table placeholders',
      );
    }
  }
}
let resolvedRoundWinners = 0;
let unresolvedRoundWinners = 0;
for (const map of detail.data.maps) {
  let ctWins = 0;
  let tWins = 0;
  const teamWins: Map<number, number> = new Map();
  for (const team of detail.data.teams) teamWins.set(team.id, 0);
  let teamScoreReliable = true;
  for (const round of map.gameLog.rounds) {
    if (round.result?.winnerSide === 'CT') ctWins += 1;
    if (round.result?.winnerSide === 'T') tWins += 1;
    if (round.result) assert.deepEqual(round.result.sideScore, { ct: ctWins, t: tWins });
    if (!round.result) continue;
    if (round.result.winnerTeamId === null) {
      unresolvedRoundWinners += 1;
      teamScoreReliable = false;
    } else {
      resolvedRoundWinners += 1;
      teamWins.set(round.result.winnerTeamId, teamWins.get(round.result.winnerTeamId)! + 1);
    }
    assert.deepEqual(
      round.result.teamScore,
      teamScoreReliable
        ? detail.data.teams.map((team) => ({ teamId: team.id, score: teamWins.get(team.id)! }))
        : null,
    );
  }
}

const capture = detail.diagnostics.capture as {
  navigationSeconds?: number;
  totalSeconds?: number;
  timings?: Record<string, number>;
  session?: { reused?: boolean; snapshotCacheHit?: boolean; ageMs?: number };
  scorebot?: { positionsVisited?: number; scoreboardPresent?: boolean };
};
const warmCapture = warmDetail.diagnostics.capture as typeof capture;
assert.equal(capture.session?.reused, false);
assert.equal(warmCapture.session?.reused, true);
assert.equal(warmCapture.timings?.navigationMs, 0);
assert.equal(warmCapture.timings?.newPageMs, 0);

assert.equal(completedStats.data.schemaVersion, '1.0.0');
assert.equal(completedStats.data.match.id, matchIdentityFromUrl(completedMatchUrl)?.id);
assert.equal(completedStats.data.availability, 'available');
assert.ok(completedStats.data.matchStats.views.length > 0);
assert.deepEqual(
  [...new Set(completedStats.data.matchStats.views.map((view) => view.side))].sort(),
  ['both', 'ct', 't'],
);
assert.equal(completedStats.diagnostics.capture.timings.scorebotReadyMs, 0);
assert.equal(completedStats.diagnostics.capture.timings.scoreboardsMs, 0);
assert.equal(completedStats.diagnostics.capture.timings.gameLogMs, 0);
const scorebotUnavailable = detail.diagnostics.warnings.some(
  (warning) => warning.code === 'SCOREBOT_UNAVAILABLE',
);
if (scorebotUnavailable) {
  assert.equal(capture.scorebot?.scoreboardPresent, false);
  assert.equal(detail.data.current, null);
} else {
  for (const [map, check] of Object.entries(detail.diagnostics.mapChecks)) {
    if (check.consistent) continue;
    assert.equal(check.status, 'completed');
    assert.ok(detail.diagnostics.warnings.some(
      (warning) =>
        warning.code === 'INCOMPLETE_GAME_LOG'
        && warning.map === map
        && warning.expectedCompletedRounds === check.scoreSum
        && warning.capturedCompletedRounds === check.completedRounds,
    ));
  }
}
assert.ok(capture.timings);
for (const [stage, durationMs] of Object.entries(capture.timings)) {
  assert.ok(Number.isFinite(durationMs) && durationMs >= 0, `${stage} timing must be finite`);
}
assert.ok((capture.navigationSeconds ?? Infinity) <= (capture.totalSeconds ?? -Infinity));
const positionsVisited = capture.scorebot?.positionsVisited ?? 0;
if (positionsVisited > 0) {
  assert.ok(
    (capture.timings.gameLogMs ?? Infinity) < Math.max(5_000, positionsVisited * 100),
    'Game log extraction must stay below the legacy 100ms-per-position wait budget',
  );
}

process.stdout.write(`${JSON.stringify({
  message: 'Real HLTV validation OK',
  liveMatches: live.data.matches.length,
  coldLiveDurationMs: live.diagnostics.durationMs,
  warmLiveDurationMs: warmLive.diagnostics.durationMs,
  warmLiveSession: warmLive.diagnostics.capture?.session,
  matchId: detail.data.match.id,
  coldCaptureSeconds: capture.totalSeconds,
  warmCaptureSeconds: warmCapture.totalSeconds,
  coldTimings: capture.timings,
  warmTimings: warmCapture.timings,
  warmSession: warmCapture.session,
  positionsVisited,
  resolvedRoundWinners,
  unresolvedRoundWinners,
  recentMatchCounts: detail.data.recentMatches.views.map((view) => ({
    modes: view.modes,
    teams: view.teams.map((team) => ({ teamId: team.teamId, matches: team.matches.length })),
  })),
  completedMatchStats: {
    matchId: completedStats.data.match.id,
    availability: completedStats.data.availability,
    views: completedStats.data.matchStats.views.length,
    durationMs: completedStats.diagnostics.durationMs,
    timings: completedStats.diagnostics.capture.timings,
  },
  currentScoreboardSides: detail.data.current?.scoreboard?.teams.map((team) => ({
    teamId: team.teamId,
    side: team.side,
  })) ?? [],
})}\n`);

async function createLiveClient() {
  const endpoint = process.env.HLTV_CDP_ENDPOINT;
  if (!endpoint) return await createHltvClient(clientOptions);
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) throw new Error('HLTV_CDP_ENDPOINT has no persistent browser context');
  const adapter: HltvBrowserAdapter = {
    newPage: async () => await context.newPage() as unknown as HltvPageAdapter,
    close: async () => await browser.close(),
  };
  return createHltvClientWithBrowser(adapter, clientOptions);
}
