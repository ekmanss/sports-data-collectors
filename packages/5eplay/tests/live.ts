import assert from 'node:assert/strict';
import { getFiveEPlayMatch } from '../src/client.js';

const match = process.env.FIVEEPLAY_MATCH_URL;
if (!match) {
  throw new Error('FIVEEPLAY_MATCH_URL is required');
}

const result = await getFiveEPlayMatch(match, { timeoutMs: 30_000 });
assert.equal(result.data.schemaVersion, '1.0.0');
assert.equal(result.data.sport, 'cs2');
assert.equal(result.data.teams.length, 2);
assert.ok(result.data.maps.length >= 1);
assert.ok(result.data.veto.length >= result.data.maps.length);
const teamIds = result.data.teams.map((team) => team.id);
for (const map of result.data.maps) {
  assert.equal(map.playerStats.length, 2);
  assert.deepEqual(map.teams.map((team) => team.teamId), teamIds);
  if (map.status === 'completed') {
    assert.equal(map.eventLog.complete, true);
    assert.ok(map.eventLog.events.length > 0);
    assert.ok(map.playerStats.every((team) => team.overall.length === 5));
    assert.ok(map.playerDuels.length > 0);
    const sample = map.playerStats[0]!.overall[0]!.metrics;
    for (const metric of [
      sample.rating, sample.kills, sample.deaths, sample.assists, sample.kdRatio,
      sample.kdDifference, sample.kastRate, sample.adr, sample.roundSwingRate,
      sample.killsPerRound, sample.deathsPerRound, sample.headshotRate, sample.firstKills,
    ]) assert.notEqual(metric, null);
  }
  if (map.status === 'live') {
    assert.ok(map.playerStats.every((team) => team.overall.length === 5));
    assert.ok(map.eventLog.events.length > 0);
  }
}

if (result.data.match.id === 'csgo_mc_2395709') {
  assert.deepEqual(result.data.maps.map((map) => map.name), ['Cache', 'Inferno', 'Nuke']);
  assert.ok(result.data.maps[0]!.eventLog.events.length >= 393);
  assert.ok(result.data.maps[1]!.eventLog.events.length >= 282);
  assert.equal(result.data.maps[0]!.playerDuels.length, 50);
  assert.equal(result.data.maps[1]!.playerDuels.length, 50);
  assert.ok(result.data.analysis);
  assert.equal(result.data.analysis.teams[0]!.players.length, 5);
  assert.equal(result.data.analysis.teams[1]!.players.length, 5);
  assert.ok((result.data.communityRatings?.tabs.length ?? 0) >= 3);
  assert.ok(result.data.communityRatings?.tabs.every((tab) => tab.cards.length > 0));
}

process.stdout.write(`${JSON.stringify({
  id: result.data.match.id,
  status: result.data.match.status,
  durationMs: result.diagnostics.durationMs,
  requests: result.diagnostics.requests.length,
  maps: result.data.maps.map((map) => ({
    number: map.number,
    name: map.name,
    status: map.status,
    score: map.teams.map((team) => team.score),
    players: map.playerStats.map((team) => team.overall.length),
    logEvents: map.eventLog.events.length,
    logComplete: map.eventLog.complete,
  })),
  analysis: result.data.analysis !== null,
  communityTabs: result.data.communityRatings?.tabs.length ?? 0,
}, null, 2)}\n`);
