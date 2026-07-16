import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { getFiveEPlayMatch } from './client.js';
import {
  renderFiveEPlayMatchMarkdown,
  type FiveEPlayMarkdownOptions,
} from './markdown.js';
import type {
  GetFiveEPlayMatchOptions,
  GetFiveEPlayMatchResult,
} from './types.js';

export interface WriteFiveEPlayMatchMarkdownOptions
  extends GetFiveEPlayMatchOptions, FiveEPlayMarkdownOptions {}

export interface WriteFiveEPlayMatchMarkdownResult {
  outputPath: string;
  bytes: number;
  result: GetFiveEPlayMatchResult;
}

export function fiveEPlayMarkdownOutputPath(target: string, matchId: string): string {
  const normalized = resolve(target);
  return extname(normalized).toLowerCase() === '.md'
    ? normalized
    : resolve(normalized, `${matchId}.md`);
}

export async function writeFiveEPlayMatchMarkdown(
  input: string,
  target: string,
  options: WriteFiveEPlayMatchMarkdownOptions = {},
): Promise<WriteFiveEPlayMatchMarkdownResult> {
  const result = await getFiveEPlayMatch(input, {
    ...options,
    includeCommunityRatings: false,
  });
  const outputPath = fiveEPlayMarkdownOutputPath(target, result.data.match.id);
  const markdown = renderFiveEPlayMatchMarkdown(result, options);
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = resolve(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, markdown, 'utf8');
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return {
    outputPath,
    bytes: Buffer.byteLength(markdown),
    result,
  };
}
