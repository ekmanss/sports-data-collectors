import { mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { MatchSnapshot } from '../domain/model.js';
import { renderMatchMarkdown } from './markdown.js';

export interface MatchArtifactOptions {
  readonly outputDirectory: string;
  readonly basename?: string;
}

export interface MatchArtifactPaths {
  readonly jsonPath: string;
  readonly markdownPath: string;
}

function defaultBasename(snapshot: MatchSnapshot): string {
  const timestamp = new Date(snapshot.observedAt).toISOString().replaceAll(':', '-');
  return `${snapshot.match.id}-${timestamp}`;
}

function validateBasename(basename: string): void {
  if (
    basename === '.'
    || basename === '..'
    || !/^[A-Za-z0-9._-]+$/.test(basename)
  ) {
    throw new TypeError('artifact basename may contain only letters, numbers, dot, underscore, and dash');
  }
}

/** Writes the complete JSON and its filtered Markdown view as a same-name pair. */
export async function writeMatchSnapshotArtifacts(
  snapshot: MatchSnapshot,
  options: MatchArtifactOptions,
): Promise<MatchArtifactPaths> {
  if (options.outputDirectory.trim() === '') {
    throw new TypeError('artifact outputDirectory must not be empty');
  }
  const basename = options.basename ?? defaultBasename(snapshot);
  validateBasename(basename);
  const outputDirectory = resolve(options.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const jsonPath = resolve(outputDirectory, `${basename}.json`);
  const markdownPath = resolve(outputDirectory, `${basename}.md`);
  const createdPaths: string[] = [];
  const handles = [];
  try {
    const jsonHandle = await open(jsonPath, 'wx', 0o600);
    handles.push(jsonHandle);
    createdPaths.push(jsonPath);
    const markdownHandle = await open(markdownPath, 'wx', 0o600);
    handles.push(markdownHandle);
    createdPaths.push(markdownPath);
    await Promise.all([
      jsonHandle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8'),
      markdownHandle.writeFile(renderMatchMarkdown(snapshot), 'utf8'),
    ]);
    await Promise.all(handles.map((handle) => handle.close()));
    return { jsonPath, markdownPath };
  } catch (error) {
    await Promise.allSettled(handles.map((handle) => handle.close()));
    await Promise.allSettled(createdPaths.map((path) => unlink(path)));
    throw error;
  }
}
