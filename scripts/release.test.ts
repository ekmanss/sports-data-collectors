import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPublishVersionIsNewer } from './publish-version-policy.js';
import { nextVersion } from './release.js';

test('increments the UTC date revision across registry and tag versions', () => {
  assert.equal(nextVersion([], new Date('2026-07-16T00:00:00Z')), '20260716.0.0');
  assert.equal(nextVersion([
    '20260715.9.0',
    '20260716.0.0',
    '20260716.2.0',
    '20260716.1.1',
  ], new Date('2026-07-16T23:59:59Z')), '20260716.3.0');
});

test('publish policy rejects versions that could move npm latest backwards', () => {
  assert.doesNotThrow(() => assertPublishVersionIsNewer('20260717.0.0', '20260716.9.0'));
  assert.doesNotThrow(() => assertPublishVersionIsNewer('20260716.10.0', '20260716.9.0'));
  assert.throws(
    () => assertPublishVersionIsNewer('20260716.9.0', '20260716.9.0'),
    /must be newer than npm latest/,
  );
  assert.throws(
    () => assertPublishVersionIsNewer('20260716.8.0', '20260716.9.0'),
    /must be newer than npm latest/,
  );
  assert.throws(
    () => assertPublishVersionIsNewer('1.2.3', '20260716.9.0'),
    /YYYYMMDD\.REVISION\.0/,
  );
});
