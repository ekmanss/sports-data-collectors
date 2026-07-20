import assert from 'node:assert/strict';
import { getFiveEPlaySchedule } from '../src/index.js';

const result = await getFiveEPlaySchedule({ pageLimit: 1, timeoutMs: 30_000 });
const ids = result.data.matches.map((match) => match.id);

assert.equal(result.data.schemaVersion, '1.0.0');
assert.equal(result.diagnostics.requests.length, 1);
assert.ok(result.diagnostics.requests.every((request) => request.kind === 'schedule-list'));
assert.deepEqual(result.diagnostics.requests.map((request) => request.page),
  Array.from({ length: result.diagnostics.requests.length }, (_, index) => index + 1));
assert.equal(new Set(ids).size, ids.length);

for (const match of result.data.matches) {
  assert.ok(['live', 'upcoming', 'unknown'].includes(match.status));
  assert.equal(match.teams.length, 2);
  assert.ok(match.url.endsWith(`/csgo/matches/${match.id}`));
  if (match.currentMap) assert.equal(match.currentMap.status, 'live');
}

process.stdout.write(`${JSON.stringify({
  capturedAt: result.data.capturedAt,
  durationMs: result.diagnostics.durationMs,
  pages: result.diagnostics.requests.length,
  complete: result.data.complete,
  nextPage: result.data.nextPage,
  total: result.data.matches.length,
  live: result.data.matches.filter((match) => match.status === 'live').length,
  upcoming: result.data.matches.filter((match) => match.status === 'upcoming').length,
  unknown: result.data.matches.filter((match) => match.status === 'unknown').length,
}, null, 2)}\n`);
