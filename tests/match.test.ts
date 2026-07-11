import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { matchIdentityFromUrl } from '../src/config.js';
import { HltvMatchError } from '../src/errors.js';
import { validateMatch } from '../src/transform/validate_match.js';
import type { HltvMatch, MatchDiagnostics, MatchMap } from '../src/types.js';

const fixturePath = resolve(
  import.meta.dirname,
  '../examples/2395674_voca-vs-regain-circuit-x-blast-open-porto-2026-north-america-rising-event/match.json',
);
const completedFixture = JSON.parse(await readFile(fixturePath, 'utf8')) as HltvMatch;
const rawSections = { sections: { matchPage: true, maps: true } };

function diagnosticsFor(match: HltvMatch): MatchDiagnostics {
  return {
    schemaVersion: '2.0.0',
    generatedAt: match.generatedAt,
    input: { id: match.match.id, slug: match.match.slug, url: match.source },
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
    matchIdentityFromUrl(`${completedFixture.source}/?ref=test#scorebot`),
    {
      id: completedFixture.match.id,
      slug: completedFixture.match.slug,
      url: completedFixture.source,
    },
  );
  assert.equal(matchIdentityFromUrl('https://example.com/matches/2395674/not-hltv'), null);
  assert.equal(matchIdentityFromUrl('https://www.hltv.org/matches/2395674'), null);
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
    capturedAt: match.generatedAt,
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
    (error: unknown) => error instanceof HltvMatchError && error.code === 'INCOMPLETE_CAPTURE',
  );
});
