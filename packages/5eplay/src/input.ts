import { FiveEPlayError } from './errors.js';
import type { FiveEPlayMatchIdentity } from './types.js';

const ID_PATTERN = /^csgo_mc_(\d+)$/;

export function matchIdentityFromInput(input: string): FiveEPlayMatchIdentity | null {
  if (typeof input !== 'string' || !input.trim()) return null;
  const value = input.trim();
  const direct = value.match(ID_PATTERN);
  if (direct) {
    const numericId = Number(direct[1]);
    if (!Number.isSafeInteger(numericId) || numericId <= 0) return null;
    return {
      id: value,
      numericId,
      url: `https://event.5eplay.com/csgo/matches/${value}`,
    };
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'event.5eplay.com') return null;
    const pathMatch = url.pathname.match(/^\/csgo\/matches\/(csgo_mc_(\d+))\/?$/);
    if (!pathMatch) return null;
    const numericId = Number(pathMatch[2]);
    if (!Number.isSafeInteger(numericId) || numericId <= 0) return null;
    const id = pathMatch[1]!;
    return { id, numericId, url: `https://event.5eplay.com/csgo/matches/${id}` };
  } catch {
    return null;
  }
}

export function requireMatchIdentity(input: string): FiveEPlayMatchIdentity {
  const identity = matchIdentityFromInput(input);
  if (identity) return identity;
  throw new FiveEPlayError(
    'match must be a csgo_mc_<id> identifier or canonical https://event.5eplay.com/csgo/matches/csgo_mc_<id> URL',
    {
      code: 'INVALID_INPUT',
      operation: 'match-detail',
      stage: 'validating-input',
      retryable: false,
    },
  );
}
