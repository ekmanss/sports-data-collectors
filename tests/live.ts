import assert from 'node:assert/strict';
import { matchIdentityFromUrl } from '../src/config.js';
import { getHltvMatch } from '../src/index.js';

const matchUrl = process.env.HLTV_MATCH_URL;
if (!matchUrl) throw new Error('set HLTV_MATCH_URL to run the real-network smoke test');

const result = await getHltvMatch(matchUrl, {
  onProgress: (event) => process.stderr.write(`[${event.stage}] ${event.message}\n`),
});

assert.equal(result.data.schemaVersion, '2.1.0');
assert.equal(result.data.match.id, matchIdentityFromUrl(matchUrl)?.id);
assert.equal(result.data.teams.length, 2);
assert.ok(result.data.maps.length > 0);
assert.ok(Object.values(result.diagnostics.mapChecks).every((check) => check.consistent));
process.stdout.write(`Live HLTV match validation OK: ${result.data.match.id}\n`);
