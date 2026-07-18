import type {
  FiveEPlayBombEvent,
  FiveEPlayJson,
  FiveEPlayKillEvent,
  FiveEPlayLogEvent,
  FiveEPlayLogPlayer,
} from './types.js';
import { flag, integer, json, record, side, text } from './value.js';

function player(
  value: Record<string, unknown>,
  nameKeys: string[],
  idKey?: string,
  sideKey?: string,
): FiveEPlayLogPlayer {
  const name = nameKeys.map((key) => text(value[key])).find(Boolean) ?? '';
  return {
    id: idKey ? text(value[idKey]) : null,
    name,
    side: sideKey ? side(value[sideKey]) : null,
  };
}

function populated(value: Record<string, unknown>): boolean {
  return Object.values(value).some((item) =>
    item !== '' && item !== null && item !== undefined && item !== false && item !== 0);
}

function kindFor(parsed: Record<string, unknown>): FiveEPlayLogEvent['kind'] {
  if (populated(record(parsed.round_start))) return 'round-start';
  if (populated(record(parsed.round_end))) return 'round-end';
  if (populated(record(parsed.player_join))) return 'player-joined';
  if (populated(record(parsed.player_quit))) return 'player-left';
  if (populated(record(parsed.kill))) return 'kill';
  if (populated(record(parsed.bomb_planted))) return 'bomb-planted';
  if (populated(record(parsed.bomb_defused))) return 'bomb-defused';
  if (populated(record(parsed.suicide))) return 'suicide';
  if (populated(record(parsed.match_started))) return 'match-started';
  if (parsed.restart !== undefined) return 'restart';
  return 'unknown';
}

function killEvent(parsed: Record<string, unknown>): FiveEPlayKillEvent | null {
  const kill = record(parsed.kill);
  if (!populated(kill)) return null;
  const assist = record(parsed.assist);
  const assister = populated(assist)
    ? player(assist, ['assister_nick', 'assister_name'], undefined, 'assister_side')
    : null;
  const flasherName = text(kill.flasher_nick);
  return {
    eventId: text(kill.event_id),
    killer: player(kill, ['killer_nick', 'killer_name'], 'killer_id', 'killer_side'),
    victim: player(kill, ['victim_nick', 'victim_name'], 'victim_id', 'victim_side'),
    assister,
    flasher: flasherName
      ? { id: null, name: flasherName, side: side(kill.flasher_side) }
      : null,
    weapon: text(kill.weapon),
    weaponLogoUrl: text(kill.weapon_logo),
    headshot: flag(kill.head_shot) === true,
    wallbang: flag(kill.penetrated) === true,
    throughSmoke: flag(kill.through_smoke) === true,
    noScope: flag(kill.no_scope) === true,
    killerBlind: flag(kill.killer_blind) === true,
    killerPosition: { x: integer(kill.killer_x), y: integer(kill.killer_y) },
    victimPosition: { x: integer(kill.victim_x), y: integer(kill.victim_y) },
  };
}

function bombEvent(parsed: Record<string, unknown>): FiveEPlayBombEvent | null {
  const bomb = record(parsed.bomb_planted);
  if (!populated(bomb)) return null;
  return {
    player: player(bomb, ['player_nick', 'player_name']),
    site: text(bomb.bomb_site),
    ctPlayers: integer(bomb.ct_players),
    tPlayers: integer(bomb.t_players),
  };
}

function parseLogInfo(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return record(value);
  if (typeof value !== 'string' || !value) return {};
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

export function transformLogRecord(value: unknown): FiveEPlayLogEvent {
  const row = record(value);
  const parsed = parseLogInfo(row.log_info);
  const roundStart = record(parsed.round_start);
  const roundEnd = record(parsed.round_end);
  const joined = record(parsed.player_join);
  const left = record(parsed.player_quit);
  const suicide = record(parsed.suicide);
  const defused = record(parsed.bomb_defused);
  const winner = side(roundEnd.winner);
  const restart = parsed.restart === undefined ? null : json(parsed.restart);
  return {
    updateVersion: text(row.update_version) ?? text(parsed.update_version) ?? '',
    matchId: text(row.match_id) ?? '',
    tournamentId: text(row.tt_id),
    mapId: text(row.bout_id),
    mapNumber: integer(row.bout_num),
    map: text(row.map_name),
    type: integer(parsed.type),
    kind: kindFor(parsed),
    roundStart: populated(roundStart) ? {
      round: integer(roundStart.round_num),
      map: text(roundStart.map),
      mapNumber: integer(roundStart.bout_num),
    } : null,
    roundEnd: populated(roundEnd) ? {
      ctScore: integer(roundEnd.ct_score),
      tScore: integer(roundEnd.t_score),
      winnerSide: winner,
      reason: text(roundEnd.win_type),
      reasonCode: integer(roundEnd.win_type_app),
    } : null,
    playerJoined: populated(joined)
      ? player(joined, ['player_nick', 'player_name'])
      : null,
    playerLeft: populated(left)
      ? player(left, ['player_nick', 'player_name'], undefined, 'player_side')
      : null,
    kill: killEvent(parsed),
    suicide: populated(suicide) ? {
      player: player(suicide, ['player_nick', 'player_name'], undefined, 'side'),
      weapon: text(suicide.weapon),
      weaponLogoUrl: text(suicide.weapon_logo),
    } : null,
    bombPlanted: bombEvent(parsed),
    bombDefused: populated(defused)
      ? player(defused, ['player_nick', 'player_name'])
      : null,
    restart: restart as FiveEPlayJson | null,
  };
}

export function compareUpdateVersions(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return left.localeCompare(right);
}

export function logEventIdentity(event: FiveEPlayLogEvent): string {
  return event.updateVersion
    ? `version:${event.updateVersion}`
    : `event:${JSON.stringify(event)}`;
}

export function mergeLogEvents(
  existing: FiveEPlayLogEvent[],
  additions: FiveEPlayLogEvent[],
): FiveEPlayLogEvent[] {
  const byVersion = new Map<string, FiveEPlayLogEvent>();
  for (const event of [...existing, ...additions]) {
    byVersion.set(logEventIdentity(event), event);
  }
  return [...byVersion.values()].sort((leftEvent, rightEvent) =>
    compareUpdateVersions(leftEvent.updateVersion, rightEvent.updateVersion));
}
