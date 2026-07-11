import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  CaptureAttempt, HltvMatch, MatchDiagnostics, MatchFiles, NormalizedGetHltvMatchOptions, RawPageCapture,
} from '../types.js';
import { matchDirectoryName, matchFiles } from './match_paths.js';

async function writeJson(path: string, value: unknown, pretty = true): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`, 'utf8');
}

function mapSlug(snapshot: CaptureAttempt['snapshot']): string {
  const value = snapshot.scoreboardNormal?.round.split(' - ').slice(1).join(' - ').trim() || 'unknown';
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

export async function createStage(options: NormalizedGetHltvMatchOptions): Promise<MatchFiles> {
  if (!options.outputRoot) throw new Error('outputRoot is required');
  await mkdir(options.outputRoot, { recursive: true });
  const name = `.${matchDirectoryName(options.id, options.slug)}.tmp-${process.pid}-${Date.now()}`;
  const directory = resolve(options.outputRoot, name);
  await mkdir(directory, { recursive: false });
  return matchFiles(options, directory);
}

export async function writeCaptureArtifacts(files: MatchFiles, capture: CaptureAttempt): Promise<void> {
  const latestPage: RawPageCapture = { ...capture.page, extracted: capture.snapshot.page };
  await mkdir(resolve(files.artifacts, 'live'), { recursive: true });
  await Promise.all([
    writeFile(resolve(files.artifacts, 'page.html'), capture.html, 'utf8'),
    writeJson(resolve(files.artifacts, 'page.json'), latestPage),
    writeJson(resolve(files.artifacts, 'page-rich.json'), capture.page),
    writeJson(resolve(files.artifacts, 'scorebot-current.json'), capture.snapshot),
    writeJson(resolve(files.artifacts, 'scorebot-latest.json'), capture.snapshot),
    writeJson(resolve(files.artifacts, 'live', `${mapSlug(capture.snapshot)}.json`), capture.snapshot),
  ]);
}

export async function writeFormalOutputs(
  files: MatchFiles,
  data: HltvMatch,
  markdown: string,
  chineseReport: string,
  diagnostics: MatchDiagnostics,
): Promise<void> {
  await Promise.all([
    writeJson(files.json, data, false),
    writeFile(files.markdown, markdown, 'utf8'),
    writeFile(files.chineseReport, chineseReport, 'utf8'),
    writeJson(files.diagnostics, diagnostics),
  ]);
}

export async function publishStage(options: NormalizedGetHltvMatchOptions, stage: MatchFiles): Promise<MatchFiles> {
  if (!options.outputRoot) throw new Error('outputRoot is required');
  const target = matchFiles(options);
  const backup = `${target.directory}.previous-${process.pid}`;
  await rm(backup, { recursive: true, force: true });
  let hadPrevious = false;
  try {
    await rename(target.directory, backup);
    hadPrevious = true;
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  try {
    await rename(stage.directory, target.directory);
    await rm(backup, { recursive: true, force: true });
    return target;
  } catch (error) {
    if (hadPrevious) await rename(backup, target.directory).catch(() => undefined);
    throw error;
  }
}

export async function discardStage(stage: MatchFiles | null): Promise<void> {
  if (stage) await rm(stage.directory, { recursive: true, force: true });
}

export async function writeFailure(
  options: NormalizedGetHltvMatchOptions,
  error: { code: string; stage: string; message: string; retryable: boolean },
  capture?: CaptureAttempt | null,
): Promise<void> {
  if (!options.outputRoot) return;
  const target = matchFiles(options);
  const failed = resolve(target.directory, 'failed-attempt');
  await rm(failed, { recursive: true, force: true });
  await mkdir(failed, { recursive: true });
  await writeJson(resolve(failed, 'last-error.json'), {
    occurredAt: new Date().toISOString(),
    input: { id: options.id, slug: options.slug, url: options.url },
    error,
  });
  if (capture) {
    await Promise.all([
      writeFile(resolve(failed, 'page.html'), capture.html, 'utf8'),
      writeJson(resolve(failed, 'page.json'), { ...capture.page, extracted: capture.snapshot.page }),
      writeJson(resolve(failed, 'scorebot.json'), capture.snapshot),
    ]);
  }
}

export async function assertOutputDirectory(files: MatchFiles): Promise<void> {
  const names = await readdir(files.directory);
  for (const required of ['match.json', 'match.md', `match-${files.json.match(/_(\d+)_/)?.[1] ?? ''}-报告.md`, 'diagnostics.json', 'artifacts']) {
    if (required.startsWith('match--')) continue;
    if (!names.includes(required)) throw new Error(`published output is missing ${required}`);
  }
}
