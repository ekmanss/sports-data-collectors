#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHltvMatch } from '../src/index.js';
import { parseMatchCliArgs } from '../src/cli/args.js';

const args = parseMatchCliArgs(process.argv.slice(2));
if ('help' in args) throw new Error('live test requires --id and --slug');
const outputRoot = await mkdtemp(join(tmpdir(), 'hltv-match-live-test-'));
try {
  const result = await getHltvMatch({
    ...args,
    outputRoot,
    onProgress: (event) => process.stderr.write(`[${event.stage}] ${event.message}\n`),
  });
  assert.equal(result.data.schemaVersion, '2.1.0');
  assert.equal(String(result.data.match.id), args.id);
  assert.equal(result.data.match.slug, args.slug);
  assert.equal(result.data.source, `https://www.hltv.org/matches/${args.id}/${args.slug}`);
  assert.ok(result.files);
  await Promise.all([
    stat(result.files.json), stat(result.files.markdown), stat(result.files.chineseReport),
    stat(result.files.diagnostics), stat(result.files.artifacts),
  ]);
  const compact = await readFile(result.files.json, 'utf8');
  assert.equal(compact, `${JSON.stringify(result.data)}\n`);
  assert.deepEqual(result.diagnostics.consumerAudit.forbiddenKeyHits, []);
  assert.deepEqual(result.diagnostics.consumerAudit.sensitiveValueHits, []);
  assert.equal(result.diagnostics.consumerAudit.allCompletedMapScoresConsistent, true);
  process.stdout.write(`Live HLTV match validation OK: ${args.id}_${args.slug}\n`);
} finally {
  await rm(outputRoot, { recursive: true, force: true });
}
