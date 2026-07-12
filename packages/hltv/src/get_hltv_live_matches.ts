import type { Browser } from 'playwright-core';
import { captureLiveMatches } from './capture/capture_live.js';
import { matchIdentityFromUrl } from './config.js';
import { HltvError, asHltvError } from './errors.js';
import { collectorVersions } from './metadata.js';
import {
  abortableDelay,
  emitProgress,
  retryDelayMilliseconds,
  throwIfStopped,
  type OperationContext,
} from './runtime.js';
import type {
  GetHltvLiveMatchesResult,
  HltvLiveMatch,
  HltvLiveMatchesData,
  HltvLiveMatchesDiagnostics,
  HltvLiveTeam,
  HltvLiveWarning,
  RawLiveCard,
} from './types.js';

function warning(warnings: HltvLiveWarning[], code: string, reason: string, matchId?: number, field?: string): void {
  warnings.push({ code, reason, ...(matchId === undefined ? {} : { matchId }), ...(field === undefined ? {} : { field }) });
}

function teamFromRaw(
  raw: RawLiveCard['teams'][number],
  matchId: number,
  index: number,
  warnings: HltvLiveWarning[],
): HltvLiveTeam {
  const prefix = `teams.${index}`;
  if (raw.id === null) warning(warnings, 'FIELD_MISSING', 'HLTV did not provide a team ID', matchId, `${prefix}.id`);
  if (raw.logoUrl === null) warning(warnings, 'FIELD_MISSING', 'HLTV did not provide a team logo', matchId, `${prefix}.logoUrl`);
  if (raw.currentMap === null) warning(warnings, 'FIELD_MISSING', 'HLTV did not provide the current-map score', matchId, `${prefix}.score.currentMap`);
  if (raw.mapsWon === null) warning(warnings, 'FIELD_MISSING', 'HLTV did not provide maps won', matchId, `${prefix}.score.mapsWon`);
  return {
    id: raw.id,
    name: raw.name,
    logoUrl: raw.logoUrl,
    score: { currentMap: raw.currentMap, mapsWon: raw.mapsWon },
  };
}

function buildMatch(raw: RawLiveCard, warnings: HltvLiveWarning[]): HltvLiveMatch | null {
  const identity = raw.url ? matchIdentityFromUrl(raw.url) : null;
  const id = raw.id ?? identity?.id ?? null;
  if (id === null || !identity || identity.id !== id) {
    warning(warnings, 'CARD_SKIPPED', 'Match ID and canonical URL could not be reconciled', id ?? undefined);
    return null;
  }
  if (raw.teams.length !== 2 || raw.teams.some((team) => !team.name)) {
    warning(warnings, 'CARD_SKIPPED', 'Exactly two named teams are required', id);
    return null;
  }
  if (raw.bestOf === null) warning(warnings, 'FIELD_MISSING', 'HLTV did not provide a recognized best-of format', id, 'bestOf');
  if (raw.region === null) warning(warnings, 'FIELD_MISSING', 'HLTV did not provide a region', id, 'region');
  if (raw.isLan === null) warning(warnings, 'FIELD_MISSING', 'HLTV did not provide the LAN flag', id, 'isLan');
  for (const field of ['id', 'name', 'type', 'logoUrl'] as const) {
    if (raw.event[field] === null) warning(warnings, 'FIELD_MISSING', `HLTV did not provide event ${field}`, id, `event.${field}`);
  }
  return {
    id,
    url: identity.url,
    status: 'live',
    bestOf: raw.bestOf,
    region: raw.region,
    isLan: raw.isLan,
    event: raw.event,
    teams: [
      teamFromRaw(raw.teams[0]!, id, 0, warnings),
      teamFromRaw(raw.teams[1]!, id, 1, warnings),
    ],
  };
}

function fill<T>(current: T | null, candidate: T | null): T | null {
  return current ?? candidate;
}

function mergeDuplicate(first: HltvLiveMatch, next: HltvLiveMatch, warnings: HltvLiveWarning[]): HltvLiveMatch {
  const conflict = (field: string, left: unknown, right: unknown): void => {
    if (left !== null && right !== null && left !== right) {
      warning(warnings, 'DUPLICATE_CONFLICT', 'Duplicate cards contained conflicting values; the first value was kept', first.id, field);
    }
  };
  conflict('bestOf', first.bestOf, next.bestOf);
  conflict('region', first.region, next.region);
  conflict('isLan', first.isLan, next.isLan);
  const event = { ...first.event };
  for (const field of ['id', 'name', 'type', 'logoUrl'] as const) {
    conflict(`event.${field}`, first.event[field], next.event[field]);
    event[field] = fill(first.event[field], next.event[field]) as never;
  }
  const teams = first.teams.map((team, index): HltvLiveTeam => {
    const other = next.teams[index]!;
    conflict(`teams.${index}.name`, team.name, other.name);
    conflict(`teams.${index}.id`, team.id, other.id);
    conflict(`teams.${index}.logoUrl`, team.logoUrl, other.logoUrl);
    conflict(`teams.${index}.score.currentMap`, team.score.currentMap, other.score.currentMap);
    conflict(`teams.${index}.score.mapsWon`, team.score.mapsWon, other.score.mapsWon);
    return {
      id: fill(team.id, other.id),
      name: team.name,
      logoUrl: fill(team.logoUrl, other.logoUrl),
      score: {
        currentMap: fill(team.score.currentMap, other.score.currentMap),
        mapsWon: fill(team.score.mapsWon, other.score.mapsWon),
      },
    };
  }) as [HltvLiveTeam, HltvLiveTeam];
  return {
    ...first,
    bestOf: fill(first.bestOf, next.bestOf),
    region: fill(first.region, next.region),
    isLan: fill(first.isLan, next.isLan),
    event,
    teams,
  };
}

function validateData(data: HltvLiveMatchesData): void {
  if (data.schemaVersion !== '1.0.0' || data.sport !== 'cs2' || !Number.isFinite(Date.parse(data.capturedAt))) {
    throw new HltvError('live result metadata is invalid', {
      code: 'INCOMPLETE_CAPTURE', operation: 'live-list', stage: 'validating-output', retryable: false,
    });
  }
  const ids = new Set<number>();
  for (const match of data.matches) {
    const identity = matchIdentityFromUrl(match.url);
    if (!identity || identity.id !== match.id || ids.has(match.id) || match.teams.length !== 2
      || (match.bestOf !== null && (!Number.isInteger(match.bestOf) || match.bestOf <= 0))) {
      throw new HltvError('live result identity is inconsistent', {
        code: 'INCOMPLETE_CAPTURE', operation: 'live-list', stage: 'validating-output', retryable: false,
        matchId: match.id,
      });
    }
    ids.add(match.id);
    if (match.teams.some((team) => !team.name
      || (team.id !== null && (!Number.isSafeInteger(team.id) || team.id <= 0))
      || [team.score.currentMap, team.score.mapsWon]
      .some((score) => score !== null && (!Number.isInteger(score) || score < 0)))) {
      throw new HltvError('live result contains an invalid team or score', {
        code: 'INCOMPLETE_CAPTURE', operation: 'live-list', stage: 'validating-output', retryable: false,
        matchId: match.id,
      });
    }
  }
}

export async function getLiveMatchesWithBrowser(
  browser: Browser,
  context: OperationContext,
): Promise<GetHltvLiveMatchesResult> {
  const attempts: HltvLiveMatchesDiagnostics['attempts'] = [];
  emitProgress(context, { stage: 'validating-input', attempt: 1, message: 'Validated live-list request' });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = new Date().toISOString();
    try {
      const capture = await captureLiveMatches(browser, context, attempt);
      attempts.push({ attempt, startedAt: capture.startedAt, completedAt: capture.completedAt, httpStatus: capture.httpStatus });
      throwIfStopped(context, 'building-output');
      emitProgress(context, { stage: 'building-output', attempt, message: 'Building live match data' });
      const warnings: HltvLiveWarning[] = [];
      if (!capture.stable) warning(warnings, 'LIVE_STATE_UNSTABLE', 'Live values changed throughout the stabilization window');
      const byId = new Map<number, HltvLiveMatch>();
      let cardsSkipped = 0;
      let duplicatesMerged = 0;
      for (const raw of capture.page.cards) {
        const match = buildMatch(raw, warnings);
        if (!match) {
          cardsSkipped += 1;
          continue;
        }
        const existing = byId.get(match.id);
        if (existing) {
          duplicatesMerged += 1;
          byId.set(match.id, mergeDuplicate(existing, match, warnings));
        } else {
          byId.set(match.id, match);
        }
      }
      const data: HltvLiveMatchesData = {
        schemaVersion: '1.0.0',
        capturedAt: capture.capturedAt,
        sport: 'cs2',
        source: { provider: 'hltv', url: 'https://www.hltv.org/matches' },
        matches: [...byId.values()],
      };
      throwIfStopped(context, 'validating-output');
      emitProgress(context, { stage: 'validating-output', attempt, message: 'Validating live match data' });
      validateData(data);
      const completedAt = new Date().toISOString();
      const diagnostics: HltvLiveMatchesDiagnostics = {
        schemaVersion: '1.0.0',
        operation: 'live-list',
        startedAt: attempts[0]?.startedAt ?? startedAt,
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(attempts[0]?.startedAt ?? startedAt)),
        collector: await collectorVersions(),
        attempts,
        summary: {
          cardsSeen: capture.page.cardsSeen,
          matchesReturned: data.matches.length,
          cardsSkipped,
          duplicatesMerged,
        },
        warnings,
      };
      emitProgress(context, { stage: 'completed', attempt, message: 'Live-list capture completed' });
      return { data, diagnostics };
    } catch (error) {
      throwIfStopped(context, 'extracting-page');
      const normalized = asHltvError(error, {
        code: 'INTERNAL_ERROR', operation: 'live-list', stage: 'extracting-page', retryable: false,
      });
      attempts.push({
        attempt,
        startedAt,
        completedAt: new Date().toISOString(),
        httpStatus: typeof normalized.details?.httpStatus === 'number' ? normalized.details.httpStatus : null,
        error: { code: normalized.code, message: normalized.message },
      });
      if (!normalized.retryable || attempt === 2) throw normalized;
      emitProgress(context, {
        stage: 'navigating',
        attempt,
        message: normalized.code === 'ACCESS_BLOCKED'
          ? 'Access challenge; cooling down before one retry'
          : 'Transient failure; retrying once',
      });
      await abortableDelay(retryDelayMilliseconds(normalized.code), context, 'navigating');
    }
  }
  throw new HltvError('live-list capture produced no result', {
    code: 'INTERNAL_ERROR', operation: 'live-list', stage: 'extracting-page', retryable: false,
  });
}
