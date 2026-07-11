import { resolve } from 'node:path';
import type { MatchFiles, NormalizedGetHltvMatchOptions } from '../types.js';

export function matchDirectoryName(id: number, slug: string): string {
  return `${id}_${slug}`;
}

export function matchFiles(options: NormalizedGetHltvMatchOptions, directory?: string): MatchFiles {
  if (!options.outputRoot && !directory) throw new Error('outputRoot is required for file output');
  const root = directory ?? resolve(options.outputRoot!, matchDirectoryName(options.id, options.slug));
  return {
    directory: root,
    json: resolve(root, 'match.json'),
    markdown: resolve(root, 'match.md'),
    chineseReport: resolve(root, `match-${options.id}-报告.md`),
    diagnostics: resolve(root, 'diagnostics.json'),
    artifacts: resolve(root, 'artifacts'),
  };
}
