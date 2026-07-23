import { createHash } from 'node:crypto';

import type {
  DataSection,
  MapNumber,
  MatchEvent,
  UnixMilliseconds,
} from '../domain/model.js';
import {
  asArray,
  asRecord,
  asString,
  integer,
  nullableNumber,
  nullableString,
  secondsToMilliseconds,
  unixMilliseconds,
} from '../internal/value.js';
import { ESPORTS_DATA_BASE_URL } from '../transport/http.js';
import type { MatchTransport } from '../transport/port.js';
import { providerData } from './shared.js';

export interface EventPageLimits {
  readonly maxPages: number;
  readonly maxEvents: number;
  readonly pageSize: number;
}

export interface EventIdentityContext {
  readonly matchId: string;
  readonly tournamentId: string;
  readonly maps: readonly {
    readonly mapNumber: MapNumber;
    readonly providerBoutNumber: number;
    readonly name: string | null;
    readonly status: 'unopened' | 'live' | 'settled' | 'closed-without-play';
  }[];
}

function canonicalMapName(value: string): string {
  return value.trim().toLowerCase().replace(/^de_/, '').replace(/[^a-z0-9]/g, '');
}

function primitiveAttributes(
  value: Record<string, unknown>,
): Readonly<Record<string, string | number | boolean | null>> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string | number | boolean | null] =>
        entry[1] === null ||
        typeof entry[1] === 'string' ||
        typeof entry[1] === 'number' ||
        typeof entry[1] === 'boolean',
    ),
  );
}

function prefixedPrimitiveAttributes(
  value: unknown,
  prefix: string,
): Readonly<Record<string, string | number | boolean | null>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(primitiveAttributes(value as Record<string, unknown>)).map(([key, entry]) => [
      `${prefix}${key}`,
      entry,
    ]),
  );
}

function normalizedPlayerId(value: unknown): string | null {
  const id = nullableString(value);
  if (id === null) return null;
  if (/^csgo_pl_[1-9]\d*$/.test(id)) return id;
  return /^[1-9]\d*$/.test(id) ? `csgo_pl_${id}` : null;
}

function eventFromRow(
  value: unknown,
  context: EventIdentityContext,
  label: string,
): MatchEvent {
  const row = asRecord(value, label);
  if (asString(row.match_id, `${label}.match_id`) !== context.matchId) {
    throw new TypeError('event match identity mismatch');
  }
  const updateVersion = asString(row.update_version, `${label}.update_version`);
  const providerBoutNumber = integer(row.bout_num, `${label}.bout_num`);
  const confirmedMap = context.maps.find(
    (map) => map.providerBoutNumber === providerBoutNumber,
  );
  const providerBoutId = asString(row.bout_id, `${label}.bout_id`);
  const providerMapName = asString(row.map_name, `${label}.map_name`);
  const tournamentId = asString(row.tt_id, `${label}.tt_id`);
  if (
    confirmedMap === undefined ||
    tournamentId !== context.tournamentId ||
    providerBoutId !== `${context.matchId}_${providerBoutNumber}` ||
    confirmedMap.name === null
  ) {
    throw new TypeError('event tournament or map identity mismatch');
  }
  if (
    providerMapName.trim() !== '' &&
    canonicalMapName(providerMapName) !== canonicalMapName(confirmedMap.name)
  ) {
    throw new TypeError('event map label mismatch');
  }
  const eventIdentity = {
    mapName: confirmedMap.name,
    mapNumber: confirmedMap.mapNumber,
    matchId: context.matchId,
    providerBoutId,
    providerBoutNumber,
    tournamentId,
  };
  const encoded = asString(row.log_info, `${label}.log_info`);
  const evidenceRef = `sha256:${createHash('sha256').update(encoded).digest('hex')}`;
  let info: Record<string, unknown> = {};
  let type = 'unknown';
  try {
    info = asRecord(JSON.parse(encoded), `${label}.log_info`);
    type = nullableString(info.type) ?? 'unknown';
  } catch {
    return {
      actorPlayerId: null,
      attributes: {},
      evidenceRef,
      ...eventIdentity,
      occurredAt: null,
      roundNumber: null,
      summary: null,
      targetPlayerId: null,
      teamId: null,
      type,
      updateVersion,
    };
  }
  const detailKey =
    type === '1'
      ? 'round_start'
      : type === '2'
        ? 'round_end'
        : type === '3'
          ? 'player_join'
          : type === '4'
            ? 'player_quit'
            : type === '6'
              ? 'bomb_planted'
              : type === '8'
                ? 'kill'
                : null;
  if (detailKey === null) {
    return {
      actorPlayerId: null,
      attributes: {},
      evidenceRef,
      ...eventIdentity,
      occurredAt: null,
      roundNumber: null,
      summary: nullableString(row.text),
      targetPlayerId: null,
      teamId: null,
      type,
      updateVersion,
    };
  }
  const detailValue = info[detailKey];
  const detail =
    detailValue === null || typeof detailValue !== 'object' || Array.isArray(detailValue)
      ? {}
      : (detailValue as Record<string, unknown>);
  return {
    actorPlayerId:
      normalizedPlayerId(detail.killer_id) ??
      normalizedPlayerId(detail.player_id) ??
      normalizedPlayerId(detail.attacker_id) ??
      null,
    attributes: {
      ...primitiveAttributes(detail),
      ...(type === '8' ? prefixedPrimitiveAttributes(info.assist, 'assist_') : {}),
    },
    evidenceRef,
    ...eventIdentity,
    occurredAt:
      secondsToMilliseconds(detail.timestamp) ?? secondsToMilliseconds(detail.time) ?? null,
    roundNumber: nullableNumber(detail.round_num),
    summary: nullableString(row.text),
    targetPlayerId:
      normalizedPlayerId(detail.victim_id) ?? normalizedPlayerId(detail.target_id) ?? null,
    teamId: nullableString(detail.team_id),
    type,
    updateVersion,
  };
}

function compareVersions(first: string, second: string): number {
  if (/^\d+$/.test(first) && /^\d+$/.test(second)) {
    const a = BigInt(first);
    const b = BigInt(second);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return first.localeCompare(second);
}

interface StoredEvent {
  readonly event: MatchEvent;
}

interface EventPage {
  readonly cursor: string | null;
  readonly events: readonly MatchEvent[];
  readonly gap: string | null;
  readonly observedAt: UnixMilliseconds;
  readonly sourceCount: number;
  readonly token: string;
}

type PageRead =
  | { readonly kind: 'ok'; readonly page: EventPage }
  | { readonly kind: 'failure'; readonly gap: string; readonly observedAt: UnixMilliseconds };

function stableProviderEventId(event: MatchEvent): string | number | null {
  const providerEventId = event.attributes.event_id;
  return typeof providerEventId === 'string' || typeof providerEventId === 'number'
    ? providerEventId
    : null;
}

function eventKey(event: MatchEvent): string {
  const providerEventId = stableProviderEventId(event);
  if (providerEventId !== null) {
    return `${event.matchId}:${event.providerBoutId ?? ''}:${event.type}:event:${providerEventId}`;
  }
  return `${event.matchId}:${event.providerBoutId ?? ''}:${event.updateVersion}`;
}

function eventPayloadFingerprint(event: MatchEvent): string {
  const { updateVersion: _updateVersion, ...stableEvent } = event;
  return createHash('sha256').update(JSON.stringify(stableEvent)).digest('hex');
}

function eventIdentityFingerprint(event: MatchEvent): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        actorPlayerId: event.actorPlayerId,
        eventId: stableProviderEventId(event),
        headShot: event.attributes.head_shot ?? null,
        killerSide: event.attributes.killer_side ?? null,
        mapName: event.mapName,
        mapNumber: event.mapNumber,
        matchId: event.matchId,
        providerBoutId: event.providerBoutId,
        providerBoutNumber: event.providerBoutNumber,
        roundNumber: event.roundNumber,
        targetPlayerId: event.targetPlayerId,
        teamId: event.teamId,
        tournamentId: event.tournamentId,
        type: event.type,
        victimSide: event.attributes.victim_side ?? null,
        weapon: event.attributes.weapon ?? null,
      }),
    )
    .digest('hex');
}

function eventRevisionsConflict(first: MatchEvent, second: MatchEvent): boolean {
  if (
    stableProviderEventId(first) === null ||
    stableProviderEventId(second) === null
  ) {
    return eventPayloadFingerprint(first) !== eventPayloadFingerprint(second);
  }
  if (eventIdentityFingerprint(first) !== eventIdentityFingerprint(second)) return true;
  return (
    compareVersions(first.updateVersion, second.updateVersion) === 0 &&
    eventPayloadFingerprint(first) !== eventPayloadFingerprint(second)
  );
}

function pageToken(rows: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export async function loadEvents(
  transport: MatchTransport,
  context: EventIdentityContext,
  limits: EventPageLimits,
  signal: AbortSignal,
): Promise<DataSection<readonly MatchEvent[]>> {
  const pageSize = limits.pageSize;
  let attempts = 0;
  let pages = 0;
  let headObservedAt = unixMilliseconds();
  let gap: string | null = null;
  let rowGap: string | null = null;
  let complete = false;
  const events = new Map<string, StoredEvent>();

  const readPage = async (cursor: string): Promise<PageRead> => {
    if (pages >= limits.maxPages) {
      return { gap: 'PAGE_LIMIT', kind: 'failure', observedAt: headObservedAt };
    }
    pages += 1;
    const url = new URL(
      `${ESPORTS_DATA_BASE_URL}/match/${encodeURIComponent(context.matchId)}/event/log`,
    );
    url.searchParams.set('update_version', cursor);
    url.searchParams.set('limit', String(pageSize));
    let response;
    try {
      response = await transport.fetchJsonWithRetry(url.toString(), signal);
    } catch {
      return {
        gap: signal.aborted ? 'DEADLINE' : 'PROVIDER_FAILURE',
        kind: 'failure',
        observedAt: unixMilliseconds(),
      };
    }
    attempts += response.attempts;
    if (cursor === '0') headObservedAt = response.observedAt;
    if (response.kind !== 'ok') {
      return {
        gap: `HTTP_${response.status}`,
        kind: 'failure',
        observedAt: response.observedAt,
      };
    }
    try {
      const data = asRecord(providerData(response.payload, 'event page'), 'event page.data');
      const rows = asArray(data.list, 'event page.data.list');
      const parsed: MatchEvent[] = [];
      let pageGap: string | null = null;
      for (const [index, row] of rows.entries()) {
        try {
          parsed.push(eventFromRow(row, context, `event page row[${index}]`));
        } catch {
          pageGap = 'EVENT_IDENTITY_OR_SCHEMA_MISMATCH';
        }
      }
      const pageEvents = new Map<string, StoredEvent>();
      for (const event of parsed) {
        const key = eventKey(event);
        const existing = pageEvents.get(key);
        if (existing !== undefined && eventRevisionsConflict(existing.event, event)) {
          pageGap = 'EVENT_VERSION_CONFLICT';
          continue;
        }
        if (
          existing === undefined ||
          compareVersions(existing.event.updateVersion, event.updateVersion) < 0
        ) {
          pageEvents.set(key, { event });
        }
      }
      let nextCursor: string | null = null;
      const lastRow = rows.at(-1);
      if (lastRow !== undefined) {
        try {
          nextCursor = asString(
            asRecord(lastRow, 'event page last row').update_version,
            'event page last row.update_version',
          );
        } catch {
          pageGap = 'EVENT_IDENTITY_OR_SCHEMA_MISMATCH';
        }
      }
      return {
        kind: 'ok',
        page: {
          cursor: nextCursor,
          events: [...pageEvents.values()].map((stored) => stored.event),
          gap: pageGap,
          observedAt: response.observedAt,
          sourceCount: rows.length,
          token: pageToken(rows),
        },
      };
    } catch {
      return {
        gap: 'EVENT_IDENTITY_OR_SCHEMA_MISMATCH',
        kind: 'failure',
        observedAt: response.observedAt,
      };
    }
  };

  const addEvents = (incoming: readonly MatchEvent[]): string | null => {
    for (const event of incoming) {
      const key = eventKey(event);
      const existing = events.get(key);
      if (existing !== undefined) {
        if (eventRevisionsConflict(existing.event, event)) return 'EVENT_VERSION_CONFLICT';
        if (compareVersions(existing.event.updateVersion, event.updateVersion) < 0) {
          events.set(key, { event });
        }
        continue;
      }
      if (events.size >= limits.maxEvents) {
        return 'EVENT_LIMIT';
      }
      events.set(key, { event });
    }
    return null;
  };

  const headOverlap = (
    page: EventPage,
    priorHead: readonly MatchEvent[],
    anchor: ReadonlyMap<string, StoredEvent>,
  ): { readonly index: number; readonly gap: string | null } => {
    for (const [index, event] of page.events.entries()) {
      const priorIndex = priorHead.findIndex(
        (priorEvent) => eventKey(priorEvent) === eventKey(event),
      );
      if (priorIndex < 0) {
        const older = anchor.get(eventKey(event));
        if (older === undefined) continue;
        return {
          gap: eventRevisionsConflict(older.event, event)
            ? 'EVENT_VERSION_CONFLICT'
            : 'HEAD_REGRESSED',
          index,
        };
      }
      if (priorIndex !== 0) return { gap: 'HEAD_REGRESSED', index };
      if (eventRevisionsConflict(priorHead[0] as MatchEvent, event)) {
        return { gap: 'EVENT_VERSION_CONFLICT', index };
      }
      const suffix = page.events.slice(index);
      if (suffix.length > priorHead.length) return { gap: 'HEAD_REGRESSED', index };
      for (const [suffixIndex, suffixEvent] of suffix.entries()) {
        const priorEvent = priorHead[suffixIndex];
        if (priorEvent === undefined || eventKey(priorEvent) !== eventKey(suffixEvent)) {
          return { gap: 'HEAD_REGRESSED', index };
        }
        if (eventRevisionsConflict(priorEvent, suffixEvent)) {
          return { gap: 'EVENT_VERSION_CONFLICT', index };
        }
      }
      if (page.sourceCount < pageSize && suffix.length !== priorHead.length) {
        return { gap: 'HEAD_REGRESSED', index };
      }
      return { gap: null, index };
    }
    return { gap: null, index: -1 };
  };

  const initial = await readPage('0');
  if (initial.kind === 'failure') {
    gap = initial.gap;
    headObservedAt = initial.observedAt;
  } else {
    rowGap = initial.page.gap;
    gap = addEvents(initial.page.events);
    let latestHeadToken = initial.page.token;
    let latestHeadEvents = initial.page.events;
    let tailComplete = initial.page.sourceCount < pageSize;
    let cursor = initial.page.cursor;
    const seenBackfillPages = new Set<string>([initial.page.token]);

    while (gap === null && !tailComplete) {
      if (cursor === null) {
        gap = 'CURSOR_DID_NOT_ADVANCE';
        break;
      }
      const previousCursor = cursor;
      const read = await readPage(cursor);
      if (read.kind === 'failure') {
        gap = read.gap;
        break;
      }
      if (seenBackfillPages.has(read.page.token)) {
        gap = 'DUPLICATE_PAGE';
        break;
      }
      seenBackfillPages.add(read.page.token);
      rowGap ??= read.page.gap;
      gap = addEvents(read.page.events);
      if (gap !== null) break;
      tailComplete = read.page.sourceCount < pageSize;
      cursor = read.page.cursor;
      if (!tailComplete && (cursor === null || cursor === previousCursor)) {
        gap = 'CURSOR_DID_NOT_ADVANCE';
      }
    }

    while (gap === null && tailComplete && !complete) {
      const anchor = new Map(events);
      const verification = await readPage('0');
      if (verification.kind === 'failure') {
        gap = verification.gap;
        break;
      }
      headObservedAt = verification.page.observedAt;
      rowGap ??= verification.page.gap;
      if (verification.page.token === latestHeadToken) {
        complete = true;
        break;
      }
      const priorHead = latestHeadEvents;
      const overlap = priorHead.length === 0
        ? { gap: null, index: -1 }
        : headOverlap(verification.page, priorHead, anchor);
      if (overlap.gap !== null) {
        gap = overlap.gap;
        break;
      }
      gap = addEvents(verification.page.events);
      if (gap !== null) break;
      if (overlap.index < 0) {
        if (verification.page.sourceCount < pageSize) {
          if (priorHead.length > 0) gap = 'HEAD_DID_NOT_OVERLAP';
          latestHeadToken = verification.page.token;
          latestHeadEvents = verification.page.events;
          continue;
        }
        let bridgeCursor = verification.page.cursor;
        const seenBridgePages = new Set<string>([verification.page.token]);
        let bridged = false;
        while (gap === null && !bridged) {
          if (bridgeCursor === null) {
            gap = 'HEAD_DID_NOT_OVERLAP';
            break;
          }
          const previousCursor = bridgeCursor;
          const bridge = await readPage(bridgeCursor);
          if (bridge.kind === 'failure') {
            gap = bridge.gap;
            break;
          }
          if (seenBridgePages.has(bridge.page.token)) {
            gap = 'DUPLICATE_PAGE';
            break;
          }
          seenBridgePages.add(bridge.page.token);
          rowGap ??= bridge.page.gap;
          const bridgeOverlap = priorHead.length === 0
            ? { gap: null, index: -1 }
            : headOverlap(bridge.page, priorHead, anchor);
          if (bridgeOverlap.gap !== null) {
            gap = bridgeOverlap.gap;
            break;
          }
          gap = addEvents(bridge.page.events);
          if (gap !== null) break;
          if (bridgeOverlap.index >= 0) {
            bridged = true;
            break;
          }
          if (bridge.page.sourceCount < pageSize) {
            if (priorHead.length === 0) bridged = true;
            else gap = 'HEAD_DID_NOT_OVERLAP';
            break;
          }
          bridgeCursor = bridge.page.cursor;
          if (bridgeCursor === null || bridgeCursor === previousCursor) {
            gap = 'CURSOR_DID_NOT_ADVANCE';
          }
        }
        if (!bridged && gap === null) gap = 'HEAD_DID_NOT_OVERLAP';
      }
      latestHeadToken = verification.page.token;
      latestHeadEvents = verification.page.events;
    }
  }

  if (complete && rowGap !== null) {
    complete = false;
    gap = rowGap;
  }
  if (!complete && gap === null) gap = 'UNKNOWN_GAP';
  const data = [...events.values()]
    .map((stored) => stored.event)
    .filter((event) => {
      const map = context.maps.find(
        (entry) => entry.providerBoutNumber === event.providerBoutNumber,
      );
      return map?.status === 'live' || map?.status === 'settled';
    })
    .sort((a, b) => compareVersions(a.updateVersion, b.updateVersion));
  const metadata = { attempts, observedAt: headObservedAt };
  if (complete) {
    return {
      ...metadata,
      data,
      gap: null,
      status: data.length === 0 ? 'empty' : 'complete',
    };
  }
  if (data.length > 0) {
    return { ...metadata, data, gap: gap ?? 'UNKNOWN_GAP', status: 'partial' };
  }
  return { ...metadata, data: null, gap: gap ?? 'UNKNOWN_GAP', status: 'unavailable' };
}
