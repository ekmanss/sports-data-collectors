import { HltvError } from './errors.js';
import type { HltvClientOptions, HltvProxyOptions } from './types.js';

export interface MatchIdentity {
  id: number;
  slug: string;
  url: string;
}

export interface NormalizedClientOptions {
  headless: boolean;
  proxy?: HltvProxyOptions;
  timezone: string;
  maxConcurrency: number;
  minRequestIntervalMs: number;
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
  throw new HltvError(message, {
    code: 'INVALID_INPUT',
    operation: 'client',
    stage: 'validating-input',
    retryable: false,
  });
}

function integerInRange(name: string, value: number | undefined, fallback: number, min: number, max: number): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    invalid(`${name} must be an integer between ${min} and ${max}`);
  }
  return normalized;
}

function normalizeProxy(proxy: HltvProxyOptions | undefined): HltvProxyOptions | undefined {
  if (proxy === undefined) return undefined;
  if (!proxy || typeof proxy !== 'object' || typeof proxy.server !== 'string' || !proxy.server.trim()) {
    invalid('proxy.server must be a non-empty URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(proxy.server);
  } catch {
    invalid('proxy.server must be a valid URL');
  }
  if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol)) {
    invalid('proxy.server must use http, https, or socks5');
  }
  if (proxy.username !== undefined && typeof proxy.username !== 'string') invalid('proxy.username must be a string');
  if (proxy.password !== undefined && typeof proxy.password !== 'string') invalid('proxy.password must be a string');
  return {
    server: proxy.server,
    ...(proxy.username === undefined ? {} : { username: proxy.username }),
    ...(proxy.password === undefined ? {} : { password: proxy.password }),
  };
}

export function normalizeClientOptions(options: HltvClientOptions = {}): NormalizedClientOptions {
  if (!options || typeof options !== 'object') invalid('client options must be an object');
  if (options.headless !== undefined && typeof options.headless !== 'boolean') invalid('headless must be a boolean');
  const timezone = options.timezone ?? 'UTC';
  if (typeof timezone !== 'string' || !timezone.trim()) invalid('timezone must be a non-empty IANA timezone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    invalid('timezone must be a valid IANA timezone');
  }
  return {
    headless: options.headless ?? true,
    proxy: normalizeProxy(options.proxy),
    timezone,
    maxConcurrency: integerInRange('maxConcurrency', options.maxConcurrency, 1, 1, 3),
    minRequestIntervalMs: integerInRange('minRequestIntervalMs', options.minRequestIntervalMs, 5_000, 0, 300_000),
  };
}

export function splitCombinedOptions<T extends HltvClientOptions & { timeoutMs?: number; signal?: AbortSignal; onProgress?: unknown }>(
  options: T | undefined,
): { client: HltvClientOptions; request: Pick<T, 'timeoutMs' | 'signal' | 'onProgress'> } {
  if (options !== undefined && (!options || typeof options !== 'object')) invalid('options must be an object');
  const value = options ?? ({} as T);
  const { timeoutMs, signal, onProgress, ...client } = value;
  return {
    client,
    request: {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(signal === undefined ? {} : { signal }),
      ...(onProgress === undefined ? {} : { onProgress }),
    },
  };
}
