import assert from 'node:assert/strict';
import { matchIdentityFromUrl } from '../src/config.js';
import { getHltvLiveMatches, getHltvMatch } from '../src/index.js';

const matchUrl = process.env.HLTV_MATCH_URL;
if (!matchUrl) throw new Error('set HLTV_MATCH_URL to run the real-network smoke test');

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

const live = await getHltvLiveMatches({ ...clientOptions, onProgress });
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

const detail = await getHltvMatch(matchUrl, { ...clientOptions, onProgress });
assert.equal(detail.data.schemaVersion, '3.0.0');
assert.equal(detail.data.match.id, matchIdentityFromUrl(matchUrl)?.id);
assert.equal(detail.data.teams.length, 2);
assert.ok(detail.data.maps.length > 0);
assert.ok(Object.values(detail.diagnostics.mapChecks).every((check) => check.consistent));

process.stdout.write(`Real HLTV validation OK: ${live.data.matches.length} live match(es), detail ${detail.data.match.id}\n`);
