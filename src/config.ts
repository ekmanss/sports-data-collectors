import { resolve } from 'node:path';
import { HltvMatchError } from './errors.js';
import type { GetHltvMatchOptions, HltvMatchProgressEvent, NormalizedGetHltvMatchOptions } from './types.js';

export const DEFAULT_OUTPUT_ROOT = resolve(process.cwd(), 'outputs/matches');
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function invalid(message: string): never {
  throw new HltvMatchError(message, { code: 'INVALID_INPUT', stage: 'validating-input', retryable: false });
}

function normalizeId(input: GetHltvMatchOptions['id']): number {
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || input <= 0) invalid('id must be a positive safe integer');
    return input;
  }
  if (!/^[1-9]\d*$/.test(input)) invalid('string id must contain digits without leading zeroes');
  const value = Number(input);
  if (!Number.isSafeInteger(value)) invalid('id exceeds Number.MAX_SAFE_INTEGER');
  return value;
}

function waitValue(name: string, value: number | undefined, fallback: number): number {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || !Number.isInteger(normalized) || normalized < 0 || normalized > 120_000) {
    invalid(`${name} must be an integer between 0 and 120000`);
  }
  return normalized;
}

export function normalizeOptions(options: GetHltvMatchOptions): NormalizedGetHltvMatchOptions {
  if (!options || typeof options !== 'object') invalid('options must be an object');
  const id = normalizeId(options.id);
  if (typeof options.slug !== 'string' || options.slug.length > 200 || !SLUG_PATTERN.test(options.slug)) {
    invalid('slug must be 1-200 lowercase letters, digits, and single hyphen-separated segments');
  }
  const writeFiles = options.writeFiles ?? true;
  if (!writeFiles && options.outputRoot !== undefined) invalid('outputRoot cannot be used when writeFiles is false');
  if (options.signal?.aborted) {
    throw new HltvMatchError('capture was aborted before it started', { code: 'ABORTED', stage: 'validating-input', retryable: false });
  }
  const url = `https://www.hltv.org/matches/${id}/${options.slug}`;
  return {
    id,
    slug: options.slug,
    url,
    outputRoot: writeFiles ? resolve(options.outputRoot ?? DEFAULT_OUTPUT_ROOT) : null,
    writeFiles,
    headless: options.headless ?? true,
    pageWaitMs: waitValue('pageWaitMs', options.pageWaitMs, 12_000),
    scorebotWaitMs: waitValue('scorebotWaitMs', options.scorebotWaitMs, 10_000),
    signal: options.signal,
    onProgress: options.onProgress,
  };
}

export function emitProgress(options: NormalizedGetHltvMatchOptions, event: Omit<HltvMatchProgressEvent, 'timestamp'>): string | null {
  if (!options.onProgress) return null;
  try {
    options.onProgress({ ...event, timestamp: new Date().toISOString() });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function throwIfAborted(options: NormalizedGetHltvMatchOptions, stage: HltvMatchProgressEvent['stage']): void {
  if (!options.signal?.aborted) return;
  throw new HltvMatchError('capture was aborted', { code: 'ABORTED', stage, retryable: false, matchId: String(options.id), slug: options.slug });
}
