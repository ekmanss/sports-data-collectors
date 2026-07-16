import assert from 'node:assert/strict';
import { getFiveEPlayLiveMatches } from '../src/live_matches.js';

const result = await getFiveEPlayLiveMatches({ timeoutMs: 15_000 });
assert.equal(result.data.schemaVersion, '1.0.0');
assert.equal(result.data.hasLiveMatches, result.data.matches.length > 0);
assert.ok(result.diagnostics.requests.length >= 1);
assert.ok(result.diagnostics.requests.every((request) => request.kind === 'live-list'));
for (const match of result.data.matches) {
  assert.equal(match.status, 'live');
  assert.equal(match.teams.length, 2);
  assert.ok(match.url.endsWith(`/csgo/matches/${match.id}`));
  assert.ok(match.maps.every((map) => map.teams.length === 2));
  if (match.currentMap) assert.equal(match.currentMap.status, 'live');
}

process.stdout.write(`${JSON.stringify({
  capturedAt: result.data.capturedAt,
  durationMs: result.diagnostics.durationMs,
  requests: result.diagnostics.requests.length,
  hasLiveMatches: result.data.hasLiveMatches,
  matches: result.data.matches.map((match) => ({
    id: match.id,
    url: match.url,
    teams: match.teams.map((team) => ({ name: team.name, score: team.seriesScore })),
    currentMap: match.currentMap && {
      name: match.currentMap.name,
      score: match.currentMap.teams.map((team) => team.score),
    },
  })),
}, null, 2)}\n`);
