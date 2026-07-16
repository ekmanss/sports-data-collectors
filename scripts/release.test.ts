import assert from 'node:assert/strict';
import test from 'node:test';
import { nextVersion, resolveTarget } from './release.js';

test('resolves only supported release packages', () => {
  assert.equal(resolveTarget('hltv').name, '@ekmanss/hltv');
  assert.equal(resolveTarget('@ekmanss/5eplay').directory, 'packages/5eplay');
  assert.throws(() => resolveTarget('unknown'), /expected hltv or 5eplay/);
});

test('increments the UTC date revision across registry and tag versions', () => {
  assert.equal(nextVersion([], new Date('2026-07-16T00:00:00Z')), '20260716.0.0');
  assert.equal(nextVersion([
    '20260715.9.0',
    '20260716.0.0',
    '20260716.2.0',
    '20260716.1.1',
  ], new Date('2026-07-16T23:59:59Z')), '20260716.3.0');
});
