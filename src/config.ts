import { HltvMatchError } from './errors.js';
import type { GetHltvMatchOptions, HltvMatchProgressEvent, NormalizedGetHltvMatchOptions } from './types.js';

export interface MatchIdentity {
  id: number;
  slug: string;
  url: string;
}

const MATCH_PATH = /^\/matches\/([1-9]\d*)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;

export function matchIdentityFromUrl(input: string): MatchIdentity | null {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  const match = parsed.pathname.match(MATCH_PATH);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.hltv.org' || !match) return null;
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id)) return null;
  const slug = match[2]!;
  return { id, slug, url: `https://www.hltv.org/matches/${id}/${slug}` };
}

function invalid(message: string): never {
  throw new HltvMatchError(message, { code: 'INVALID_INPUT', stage: 'validating-input', retryable: false });
}

function waitValue(name: string, value: number | undefined, fallback: number): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > 120_000) {
    invalid(`${name} must be an integer between 0 and 120000`);
  }
  return normalized;
}

export function normalizeOptions(matchUrl: string, options: GetHltvMatchOptions = {}): NormalizedGetHltvMatchOptions {
  const identity = typeof matchUrl === 'string' ? matchIdentityFromUrl(matchUrl) : null;
  if (!identity) invalid('matchUrl must be a canonical https://www.hltv.org/matches/<id>/<slug> URL');
  if (!options || typeof options !== 'object') invalid('options must be an object');
  if (options.signal?.aborted) {
    throw new HltvMatchError('capture was aborted before it started', {
      code: 'ABORTED', stage: 'validating-input', retryable: false, matchId: String(identity.id),
    });
  }
  return {
    ...identity,
    headless: options.headless ?? true,
    pageWaitMs: waitValue('pageWaitMs', options.pageWaitMs, 12_000),
    scorebotWaitMs: waitValue('scorebotWaitMs', options.scorebotWaitMs, 10_000),
    signal: options.signal,
    onProgress: options.onProgress,
  };
}

export function emitProgress(
  options: NormalizedGetHltvMatchOptions,
  event: Omit<HltvMatchProgressEvent, 'timestamp'>,
): void {
  try {
    options.onProgress?.({ ...event, timestamp: new Date().toISOString() });
  } catch {
    // Progress is observational and must never make an otherwise valid capture fail.
  }
}

export function throwIfAborted(
  options: NormalizedGetHltvMatchOptions,
  stage: HltvMatchProgressEvent['stage'],
): void {
  if (!options.signal?.aborted) return;
  throw new HltvMatchError('capture was aborted', {
    code: 'ABORTED', stage, retryable: false, matchId: String(options.id),
  });
}
