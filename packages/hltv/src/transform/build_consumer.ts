import { matchIdentityFromUrl } from '../config.js';
import type {
  CaptureAttempt, CombinedScoreboard, DiagnosticWarning, GameLogEvent, GameRound, HeadToHead, HltvMatch, HltvPlayer,
  HltvTeam, MapStats, MatchDiagnostics, MatchMap, MatchStats, RawExtractedPage, RawLogEvent, RawMapCard,
  RawMatchStats, RawScoreboard, RawSnapshot, RecentMatches, ScoreboardPlayer, VetoEntry,
} from '../types.js';

type RawRound = {
  events: RawLogEvent[];
  result: null | { winnerSide: 'CT' | 'T' | null; ctScore: number | null; tScore: number | null; reason: string | null };
};

type RawSegment = { rounds: RawRound[]; completedRounds: number };

const jsonEqual = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

function mergeLatestWithRich(latest: RawExtractedPage, rich: RawExtractedPage | null): { data: RawExtractedPage; fallbackSections: string[] } {
  if (!rich) return { data: latest, fallbackSections: [] };
  const data = structuredClone(latest);
  const fallbackSections: string[] = [];
  const useRich = (key: string, missing: boolean): void => {
    if (missing && rich[key] !== undefined && rich[key] !== null) {
      data[key] = structuredClone(rich[key]);
      fallbackSections.push(key);
    }
  };
  useRich('streams', !data.streams?.length && Boolean(rich.streams?.length));
  useRich('matchStats', !data.matchStats && Boolean(rich.matchStats));
  useRich('mapStats', !data.mapStats && Boolean(rich.mapStats));
  useRich('recentMatches', !data.recentMatches?.length && Boolean(rich.recentMatches?.length));
  useRich('headToHead', !data.headToHead && Boolean(rich.headToHead));

  if (data.lineups?.length && rich.lineups?.length) {
    let enriched = false;
    data.lineups = data.lineups.map((lineup) => {
      const richLineup = rich.lineups.find((item) => item.id === lineup.id);
      if (!richLineup) return lineup;
      return {
        ...richLineup,
        ...lineup,
        players: lineup.players.map((player) => {
          const richPlayer = richLineup.players.find((item) => item.id === player.id);
          if (!richPlayer) return player;
          const output = { ...richPlayer, ...player };
          const outputValues = output as unknown as Record<string, unknown>;
          const richValues = richPlayer as unknown as Record<string, unknown>;
          const fallbackKeys = ['profileUrl', 'statsUrl', 'rating', 'kpr', 'dpr', 'kast', 'adr'] as const;
          for (const key of fallbackKeys) {
            if (outputValues[key] === null || outputValues[key] === '') {
              outputValues[key] = richValues[key];
              enriched = true;
            }
          }
          if (!output.stats || Object.keys(output.stats).length === 0) {
            output.stats = richPlayer.stats;
            enriched = true;
          }
          return output;
        }),
      };
    });
    if (enriched) fallbackSections.push('lineupPlayerMetrics');
  } else useRich('lineups', Boolean(rich.lineups?.length));
  return { data, fallbackSections };
}

function numberFrom(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '').replace('%', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function rateFrom(numericValue: unknown, displayPercent: unknown): number | null {
  const numeric = numberFrom(numericValue);
  if (numeric !== null) return numeric;
  const percent = numberFrom(displayPercent);
  return percent === null ? null : percent / 100;
}

function integerFrom(value: unknown): number | null {
  const parsed = numberFrom(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function idFromName<T extends { id: number; name: string }>(items: T[], name: string | null | undefined): number | null {
  return items.find((item) => item.name === name)?.id ?? null;
}

function mapName(snapshot: RawSnapshot): string {
  return snapshot.scoreboardNormal?.round.split(' - ').slice(1).join(' - ').trim() || 'Unknown';
}

function formalEvents(events: RawLogEvent[]): { events: RawLogEvent[]; excluded: number } {
  const output: RawLogEvent[] = [];
  let inRound = false;
  for (const event of events) {
    if (event.text === 'Round started') inRound = true;
    if (!inRound) continue;
    output.push(event);
    if (event.text.startsWith('Round over')) inRound = false;
  }
  return { events: output, excluded: events.length - output.length };
}

function eventKey(event: RawLogEvent): string {
  return JSON.stringify({
    text: event.text,
    type: event.type ?? [],
    players: event.players ?? [],
    weapon: event.weapon ?? null,
    headshot: Boolean(event.headshot),
  });
}

function deduplicateAdjacent(events: RawLogEvent[]): { events: RawLogEvent[]; removed: number } {
  const output: RawLogEvent[] = [];
  let removed = 0;
  for (const event of events) {
    const previous = output.at(-1);
    if (previous && eventKey(previous) === eventKey(event)) {
      removed += 1;
      continue;
    }
    output.push(event);
  }
  return { events: output, removed };
}

function parseRoundResult(text: string): RawRound['result'] {
  const match = text.match(/^Round over - Winner: (CT|T) \((\d+) - (\d+)\) - (.*)$/);
  return match ? {
    winnerSide: match[1] as 'CT' | 'T',
    ctScore: Number(match[2]),
    tScore: Number(match[3]),
    reason: match[4] || null,
  } : null;
}

function groupRounds(events: RawLogEvent[]): RawRound[] {
  const rounds: RawRound[] = [];
  let current: RawRound | null = null;
  for (const event of events) {
    if (event.text === 'Round started') {
      if (current) rounds.push(current);
      current = { events: [], result: null };
      continue;
    }
    if (!current) continue;
    if (event.text.startsWith('Round over')) {
      const result = parseRoundResult(event.text);
      if (result) {
        current.result = result;
        rounds.push(current);
      }
      current = null;
      continue;
    }
    current.events.push(event);
  }
  if (current) rounds.push(current);
  return rounds;
}

function resultTotal(round: RawRound): number | null {
  if (!round.result || round.result.ctScore === null || round.result.tScore === null) return null;
  return round.result.ctScore + round.result.tScore;
}

function segmentRounds(rounds: RawRound[]): RawSegment[] {
  const segments: RawSegment[] = [];
  let current: RawRound[] = [];
  let previousTotal = 0;
  for (const round of rounds) {
    const total = resultTotal(round);
    if (total !== null && current.length && total !== previousTotal + 1) {
      segments.push({ rounds: current, completedRounds: current.filter((item) => resultTotal(item) !== null).length });
      current = [];
      previousTotal = 0;
    }
    current.push(round);
    if (total !== null) previousTotal = total;
  }
  if (current.length) segments.push({ rounds: current, completedRounds: current.filter((item) => resultTotal(item) !== null).length });
  return segments;
}

type ReconstructedRounds = {
  rounds: RawRound[];
  firstSegmentIndex: number;
  sourceSegments: number[];
  overlappingRounds: number;
};

function resultIdentity(round: RawRound): string | null {
  if (!round.result || round.result.ctScore === null || round.result.tScore === null) return null;
  const scores = [round.result.ctScore, round.result.tScore].sort((left, right) => left - right);
  return `${scores[0]}:${scores[1]}`;
}

function scoredRoundsByTotal(segment: RawSegment, target: number): Map<number, RawRound> {
  const output = new Map<number, RawRound>();
  for (const round of segment.rounds) {
    const total = resultTotal(round);
    if (total !== null && total >= 1 && total <= target) output.set(total, round);
  }
  return output;
}

function reconstructOverlappingSegments(
  segments: RawSegment[],
  lastSegmentIndex: number,
  target: number,
  includeUnfinishedTail: boolean,
): ReconstructedRounds | null {
  let tailIndex = -1;
  for (let index = lastSegmentIndex; index >= 0; index -= 1) {
    if (scoredRoundsByTotal(segments[index]!, target).has(target)) {
      tailIndex = index;
      break;
    }
  }
  if (tailIndex < 0) return null;

  const selected = scoredRoundsByTotal(segments[tailIndex]!, target);
  const sourceSegments = [tailIndex];
  let firstSegmentIndex = tailIndex;
  let overlappingRounds = 0;
  let frontier = target;
  while (selected.has(frontier)) frontier -= 1;

  while (frontier > 0) {
    let best: { index: number; rounds: Map<number, RawRound>; overlap: number } | null = null;
    for (let index = firstSegmentIndex - 1; index >= 0; index -= 1) {
      const candidate = scoredRoundsByTotal(segments[index]!, target);
      if (!candidate.has(frontier)) continue;
      const selectedBoundary = selected.get(frontier + 1);
      const candidateBoundary = candidate.get(frontier + 1);
      if (!selectedBoundary || !candidateBoundary
        || resultIdentity(selectedBoundary) !== resultIdentity(candidateBoundary)) continue;
      const overlapping = [...candidate].filter(([total, round]) => {
        const selectedRound = selected.get(total);
        return selectedRound && resultIdentity(selectedRound) === resultIdentity(round);
      }).length;
      if (!best || overlapping > best.overlap || (overlapping === best.overlap && index > best.index)) {
        best = { index, rounds: candidate, overlap: overlapping };
      }
    }
    if (!best) return null;
    for (const [total, round] of best.rounds) {
      if (!selected.has(total)) selected.set(total, round);
    }
    overlappingRounds += best.overlap;
    sourceSegments.push(best.index);
    firstSegmentIndex = best.index;
    while (selected.has(frontier)) frontier -= 1;
  }

  const rounds = Array.from({ length: target }, (_, index) => selected.get(index + 1)!);
  if (includeUnfinishedTail) {
    const tail = segments[tailIndex]!.rounds;
    let completedIndex = -1;
    for (let index = tail.length - 1; index >= 0; index -= 1) {
      if (resultTotal(tail[index]!) === target) {
        completedIndex = index;
        break;
      }
    }
    rounds.push(...tail.slice(completedIndex + 1).filter((round) => resultTotal(round) === null));
  }
  return { rounds, firstSegmentIndex, sourceSegments: sourceSegments.sort((a, b) => a - b), overlappingRounds };
}

function selectRoundSegments(
  segments: RawSegment[],
  maps: RawMapCard[],
  currentMap: string | null,
  currentScoreSum: number,
): { assignments: Map<string, RawRound[]>; diagnostics: Record<string, unknown> } {
  const assignments = new Map<string, RawRound[]>();
  const reconciliation = new Map<string, { sourceSegments: number[]; overlappingRounds: number }>();
  const currentIndex = Math.max(0, maps.findIndex((map) => map.name === currentMap));
  const expected = maps.slice(0, currentIndex + 1).map((map, index) => {
    const cardScores = map.teams.map((team) => Number(team.score));
    const completed = cardScores.every(Number.isFinite) ? cardScores.reduce((sum: number, score: number) => sum + score, 0) : null;
    // HLTV's live map card exposes the finished half score (for example 4:8)
    // while Scorebot already has the authoritative current total (10:9).
    // The Scorebot total therefore always wins for the current map.
    return { name: map.name, completedRounds: index === currentIndex ? currentScoreSum : (completed ?? 0) };
  });

  let segmentIndex = segments.length - 1;
  for (let expectedIndex = expected.length - 1; expectedIndex >= 0; expectedIndex -= 1) {
    const target = expected[expectedIndex]!;
    if (target.completedRounds === 0) {
      const last = segments[segmentIndex];
      if (last?.completedRounds === 0) {
        assignments.set(target.name, last.rounds);
        segmentIndex -= 1;
      } else {
        // A first in-progress round can be appended to the completed previous
        // segment because it has no reset score yet. Split that tail here.
        const previousTarget = expected[expectedIndex - 1];
        if (last && previousTarget && last.completedRounds === previousTarget.completedRounds) {
          let lastResultIndex = -1;
          for (let roundIndex = last.rounds.length - 1; roundIndex >= 0; roundIndex -= 1) {
            if (last.rounds[roundIndex]!.result) {
              lastResultIndex = roundIndex;
              break;
            }
          }
          assignments.set(target.name, last.rounds.slice(lastResultIndex + 1));
          last.rounds = last.rounds.slice(0, lastResultIndex + 1);
        } else assignments.set(target.name, []);
      }
      continue;
    }
    const reconstructed = reconstructOverlappingSegments(
      segments,
      segmentIndex,
      target.completedRounds,
      expectedIndex === currentIndex,
    );
    if (!reconstructed) {
      assignments.set(target.name, []);
      continue;
    }
    assignments.set(target.name, reconstructed.rounds);
    reconciliation.set(target.name, {
      sourceSegments: reconstructed.sourceSegments,
      overlappingRounds: reconstructed.overlappingRounds,
    });
    segmentIndex = reconstructed.firstSegmentIndex - 1;
  }
  for (const map of maps) if (!assignments.has(map.name)) assignments.set(map.name, []);
  return {
    assignments,
    diagnostics: {
      detectedSegments: segments.map((segment, index) => ({ index, completedRounds: segment.completedRounds, totalRounds: segment.rounds.length })),
      expected,
      assigned: Object.fromEntries([...assignments].map(([name, rounds]) => [name, {
        completedRounds: rounds.filter((round) => resultTotal(round) !== null).length,
        totalRounds: rounds.length,
        sourceSegments: reconciliation.get(name)?.sourceSegments ?? [],
        overlappingRounds: reconciliation.get(name)?.overlappingRounds ?? 0,
      }])),
    },
  };
}

type ScoreboardModePlayer = Record<string, string | number | boolean | string[] | null> & { nickname: string };
type ScoreboardMode = {
  mode: string;
  round: string;
  fact: string;
  score: string;
  teams: Array<{ name: string; players: ScoreboardModePlayer[] }>;
};

function normalizeScoreboardMode(scoreboard: RawScoreboard | null): ScoreboardMode | null {
  if (!scoreboard) return null;
  return {
    mode: scoreboard.mode,
    round: scoreboard.round,
    fact: scoreboard.fact,
    score: scoreboard.score,
    teams: scoreboard.teams.map((team) => ({
      name: team.team,
      players: team.players.map((raw) => {
        const player: ScoreboardModePlayer = { nickname: raw.player };
        let center = 0;
        const advanced = ['openingDuels', 'multiKills', 'kast', 'clutches'];
        for (const cell of raw.cells) {
          const images = cell.images.map((image) => image.src?.split('/').pop()?.replace('.png', '')).filter((image): image is string => Boolean(image));
          if (cell.className.includes('identityColumns')) continue;
          if (cell.className.includes('defuseKit')) player.defuseKit = images.length > 0;
          else if (cell.className.includes('weaponCell')) player.weapons = images;
          else if (cell.className.includes('hpCell')) player.health = numberFrom(cell.text);
          else if (cell.className.includes('armorCell')) player.armor = images;
          else if (cell.className.includes('moneyCell')) player.money = numberFrom(cell.text.replace('$', ''));
          else if (cell.className.includes('killCell')) player.kills = numberFrom(cell.text);
          else if (cell.className.includes('assistFlashCell')) player.flashAssists = numberFrom(cell.text);
          else if (cell.className.includes('assistCell')) player.assists = numberFrom(cell.text);
          else if (cell.className.includes('deathCell')) player.deaths = numberFrom(cell.text);
          else if (cell.className.includes('adrCell')) player.adr = numberFrom(cell.text);
          else if (cell.className.includes('centerCell') && center < advanced.length) player[advanced[center++]!] = cell.text;
        }
        return player;
      }),
    })),
  };
}

function combineScoreboards(
  normalRaw: RawScoreboard | null,
  advancedRaw: RawScoreboard | null,
  teams: { id: number; name: string }[],
  players: { id: number; nickname: string }[],
): CombinedScoreboard | null {
  const normal = normalizeScoreboardMode(normalRaw);
  const advanced = normalizeScoreboardMode(advancedRaw);
  if (!normal && !advanced) return null;
  const base = normal ?? advanced;
  if (!base) return null;
  return {
    fact: base.fact || null,
    teams: base.teams.map((team) => {
      const advancedTeam = advanced?.teams.find((item) => item.name === team.name);
      const teamId = idFromName(teams, team.name);
      return {
        teamId,
        ...(teamId === null ? { name: team.name } : {}),
        players: team.players.map((normalPlayer) => {
          const advancedPlayer = advancedTeam?.players.find((item) => item.nickname === normalPlayer.nickname) ?? { nickname: normalPlayer.nickname };
          const playerId = players.find((player) => player.nickname === normalPlayer.nickname)?.id ?? null;
          const stateKeys = ['defuseKit', 'weapons', 'health', 'armor', 'money'];
          const normalKeys = ['kills', 'assists', 'flashAssists', 'deaths', 'adr'];
          const advancedKeys = ['openingDuels', 'multiKills', 'kast', 'clutches'];
          const pick = (source: ScoreboardModePlayer, keys: string[]): ScoreboardPlayer['state'] => Object.fromEntries(
            keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key] ?? null]),
          );
          return {
            playerId,
            ...(playerId === null ? { nickname: normalPlayer.nickname } : {}),
            state: pick(normalPlayer, stateKeys),
            normal: pick(normalPlayer, normalKeys),
            advanced: pick(advancedPlayer, advancedKeys),
          };
        }),
      };
    }),
  };
}

function scoreEntries(scoreboard: RawScoreboard | null, teams: { id: number; name: string }[]): { teamId: number | null; score: number }[] {
  if (!scoreboard) return [];
  const values = scoreboard.score.split(':').map((part) => Number(part.trim()));
  return scoreboard.teams.slice(0, 2).map((team, index) => ({
    teamId: idFromName(teams, team.team),
    score: Number.isFinite(values[index]) ? values[index]! : 0,
  }));
}

function scoresMatch(left: { teamId: number | null; score: number }[], right: { teamId: number | null; score: number }[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item) => right.some((other) => other.teamId === item.teamId && other.score === item.score));
}

function normalizeLogEvent(event: RawLogEvent, players: { id: number; nickname: string }[]): GameLogEvent {
  const sideClasses = new Set(['CT', 'T', 'TERRORIST']);
  const kind = (event.type ?? []).find((value) => !sideClasses.has(value)) ?? 'event';
  const output: GameLogEvent = { kind, text: event.text };
  if (event.players?.length) output.players = event.players.map((player) => {
    const playerId = players.find((item) => item.nickname === player.name)?.id ?? null;
    return { playerId, ...(playerId === null ? { nickname: player.name } : {}), side: player.side };
  });
  if (event.weapon) output.weapon = event.weapon;
  if (event.headshot) output.headshot = true;
  return output;
}

function normalizeRounds(rounds: RawRound[], players: { id: number; nickname: string }[]): GameRound[] {
  return rounds.map((round, index) => ({
    number: index + 1,
    events: round.events.map((event) => normalizeLogEvent(event, players)),
    result: round.result ? {
      winnerSide: round.result.winnerSide,
      sideScore: round.result.ctScore === null ? null : { ct: round.result.ctScore, t: round.result.tScore },
      reason: round.result.reason,
    } : null,
  }));
}

function parseHalfScores(value: string): { team1: number; team2: number }[] {
  const match = value.match(/\(([^)]+)\)/);
  if (!match) return [];
  return match[1]!.split(';').flatMap((half) => {
    const scores = half.trim().split(':').map(Number);
    return scores.length === 2 && scores.every(Number.isFinite) ? [{ team1: scores[0]!, team2: scores[1]! }] : [];
  });
}

type RawMapStatDetail = { action: string | null; percentage: string | null; sample: string | null; statsUrl: string | null };
type RawMapStats = {
  teamDetails: Array<{ id: number | null }>;
  metrics: Record<string, Array<{
    map: string; mapCode: string | null; notPicked: boolean;
    team1Details: RawMapStatDetail; team2Details: RawMapStatDetail;
  }>>;
};
type RawRecentView = {
  mode: string;
  teams: Array<{
    teamId: number | null;
    matches: Array<{
      opponentId: number | null; opponent: string; opponentCountry: string | null; opponentUrl: string | null;
      timeAgo: string; format: string; score: string; result: 'won' | 'lost' | null;
      matchId: number | null; matchUrl: string | null;
    }>;
  }>;
};
type RawHeadToHead = {
  team1Wins: string; team2Wins: string; overtimes: string;
  teams: Array<{ id: number | null }>;
  matches: Array<{
    id: number | null; url: string | null; date: string; unixMs: number | null; event: HeadToHead['matches'][number]['event'];
    teams: Array<{ id: number | null; lineup: string[]; winner: boolean }>;
    maps: Array<{
      name: string; code: string; picked: boolean;
      scores: Array<{ teamId: number | null; score: number }>;
    }>;
  }>;
};

function normalizeMapStats(input: unknown): MapStats {
  const raw = input as RawMapStats | null;
  if (!raw) return { teamIds: [], metrics: {} };
  const teamIds = raw.teamDetails.map((team) => team.id);
  const parsePercentage = (value: string | null) => value && value !== '-' ? numberFrom(value) : null;
  const parseSample = (value: string | null) => {
    const match = value?.match(/(\d+)\s+(.+)/);
    if (!match) return null;
    const rawUnit = match[2]!.toLowerCase();
    return { count: Number(match[1]), unit: rawUnit.startsWith('map') ? 'map' : rawUnit.startsWith('possibilit') ? 'possibility' : rawUnit };
  };
  return {
    teamIds,
    metrics: Object.fromEntries(Object.entries(raw.metrics).map(([metric, rows]) => [metric, rows.map((row) => ({
      map: row.map,
      mapCode: row.mapCode,
      excludedFromSeries: Boolean(row.notPicked),
      teams: [row.team1Details, row.team2Details].map((detail, index) => ({
        teamId: teamIds[index] ?? null,
        action: detail.action ? detail.action.toLowerCase() : null,
        percentage: parsePercentage(detail.percentage),
        sample: parseSample(detail.sample),
        statsUrl: detail.statsUrl,
      })),
    }))])),
  };
}

function normalizeMatchStats(
  input: RawMatchStats | null | undefined,
  teams: HltvTeam[],
  players: HltvPlayer[],
): MatchStats {
  if (!input) return { views: [] };
  return {
    views: input.views.map((view) => ({
      mapStatsId: view.mapStatsId,
      map: view.map,
      side: view.side,
      teams: view.teams.map((team) => ({
        teamId: team.id ?? idFromName(teams, team.name),
        name: team.name,
        players: team.players.map((player) => ({
          playerId: player.id ?? players.find((item) => item.nickname === player.nickname)?.id ?? null,
          nickname: player.nickname,
          traditional: {
            kills: integerFrom(player.kills),
            deaths: integerFrom(player.deaths),
            adr: numberFrom(player.adr),
            kastRate: rateFrom(null, player.kast),
          },
          ecoAdjusted: {
            kills: integerFrom(player.ecoAdjustedKills),
            deaths: integerFrom(player.ecoAdjustedDeaths),
            adr: numberFrom(player.ecoAdjustedAdr),
            kastRate: rateFrom(null, player.ecoAdjustedKast),
          },
          roundSwingRate: rateFrom(null, player.roundSwing),
          rating: numberFrom(player.rating),
        })),
      })),
    })),
  };
}

function normalizeRecent(input: unknown[]): RecentMatches {
  const raw = input as RawRecentView[];
  if (!raw?.length) return { period: 'past 3 months', views: [] };
  const views = raw.map((view) => ({
    modes: [view.mode],
    teams: view.teams.map((team) => ({
      teamId: team.teamId,
      matches: team.matches.map((match) => {
        const scores = String(match.score).split('-').map((part) => Number(part.trim()));
        return {
          opponent: { id: match.opponentId, name: match.opponent, country: match.opponentCountry, url: match.opponentUrl },
          timeAgo: match.timeAgo || null,
          format: match.format,
          score: scores.length === 2 && scores.every(Number.isFinite) ? { team: scores[0]!, opponent: scores[1]! } : null,
          result: match.result,
          match: { id: match.matchId, url: match.matchUrl },
        };
      }),
    })),
  }));
  const merged: RecentMatches['views'] = [];
  for (const view of views) {
    const existing = merged.find((item) => jsonEqual(item.teams, view.teams));
    if (existing) existing.modes.push(...view.modes);
    else merged.push(view);
  }
  return { period: 'past 3 months', views: merged };
}

function normalizeHeadToHead(input: unknown): HeadToHead {
  const raw = input as RawHeadToHead | null;
  if (!raw) return { summary: { teams: [], overtimes: 0 }, matches: [] };
  return {
    summary: {
      teams: [
        { teamId: raw.teams[0]?.id ?? null, wins: Number(raw.team1Wins) },
        { teamId: raw.teams[1]?.id ?? null, wins: Number(raw.team2Wins) },
      ],
      overtimes: Number(raw.overtimes),
    },
    matches: raw.matches.map((match) => ({
      id: match.id,
      url: match.url,
      date: match.date,
      unixMs: match.unixMs,
      event: match.event,
      lineups: match.teams.map((team) => ({ teamId: team.id, players: team.lineup, winner: team.winner })),
      maps: match.maps.map((map) => ({ name: map.name, code: map.code, picked: map.picked, scores: map.scores.map((score) => ({ teamId: score.teamId, score: score.score })) })),
    })),
  };
}

function normalizeVeto(veto: string[], teams: { id: number; name: string }[]): VetoEntry[] {
  return veto.map((text) => {
    const teamAction = text.match(/^(\d+)\. (.+) (removed|picked) (.+)$/);
    if (teamAction) return {
      order: Number(teamAction[1]),
      teamId: idFromName(teams, teamAction[2]),
      action: teamAction[3] === 'removed' ? 'remove' : 'pick',
      map: teamAction[4]!,
    };
    const leftOver = text.match(/^(\d+)\. (.+) was left over$/);
    return { order: Number(leftOver?.[1] ?? 0), teamId: null, action: 'left_over', map: leftOver?.[2] ?? text };
  });
}

function requireId(value: number | null, label: string): number {
  if (value === null || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is missing a valid ID`);
  return value;
}

export function buildConsumerFromCapture(
  capture: CaptureAttempt,
  attempts: MatchDiagnostics['attempts'],
): { data: HltvMatch; diagnostics: MatchDiagnostics } {
  const snapshot = capture.snapshot;
  const identity = matchIdentityFromUrl(snapshot.page.url);
  if (!identity) throw new Error('final snapshot has an invalid HLTV match URL');
  const mergedStatic = mergeLatestWithRich(snapshot.page, capture.initialPage);
  const staticData = mergedStatic.data;
  const snapshotsByMap = new Map([[mapName(snapshot), snapshot]]);

  const teams: HltvTeam[] = staticData.teams.map((team) => ({ id: requireId(team.id, `team ${team.name}`), name: team.name, country: team.country, url: team.url, logo: team.logo }));
  const players: HltvPlayer[] = staticData.lineups.flatMap((lineup) => lineup.players.map((player) => ({
    id: requireId(player.id, `player ${player.nickname}`),
    nickname: player.nickname,
    fullName: player.fullName,
    country: player.country,
    image: player.image,
    bodyshotUrl: typeof player.stats.bodyshotUrl === 'string' ? player.stats.bodyshotUrl : null,
    profileUrl: player.profileUrl,
    statsUrl: player.statsUrl,
    metrics: {
      rating: numberFrom(player.stats?.numericRating ?? player.rating),
      killsPerRound: numberFrom(player.stats?.numericKpr ?? player.kpr),
      deathsPerRound: numberFrom(player.stats?.numericDpr ?? player.dpr),
      kastRate: rateFrom(player.stats?.numericKast, player.kast),
      adr: numberFrom(player.stats?.numericAdr ?? player.adr),
      multiKillRating: numberFrom(player.stats?.numericMultiKillRating),
      roundSwingRate: rateFrom(player.stats?.numericRoundSwing, player.stats?.roundSwing),
    },
  })));
  for (const player of staticData.matchStats?.views.flatMap((view) =>
    view.teams.flatMap((team) => team.players)) ?? []) {
    if (player.id === null || players.some((item) => item.id === player.id)) continue;
    players.push({
      id: player.id,
      nickname: player.nickname,
      fullName: player.fullName ?? null,
      country: player.country ?? null,
      image: null,
      bodyshotUrl: null,
      profileUrl: player.profileUrl ?? null,
      statsUrl: null,
      metrics: {
        rating: null,
        killsPerRound: null,
        deathsPerRound: null,
        kastRate: null,
        adr: null,
        multiKillRating: null,
        roundSwingRate: null,
      },
    });
  }
  const lineups = staticData.lineups.map((lineup) => ({
    teamId: requireId(lineup.id, `lineup ${lineup.name}`),
    worldRank: lineup.worldRank,
    playerIds: lineup.players.map((player) => requireId(player.id, `player ${player.nickname}`)),
  }));

  const filtered = formalEvents(snapshot.gameLog.chronological);
  const deduplicated = deduplicateAdjacent(filtered.events);
  const rawRounds = groupRounds(deduplicated.events);
  const segments = segmentRounds(rawRounds);
  const matchOver = String(staticData.match.status).toLowerCase().includes('over');
  const stateSnapshot = snapshot;
  let currentMap = mapName(stateSnapshot);
  if (matchOver) {
    for (const map of staticData.maps.maps) {
      if (map.teams.map((team) => Number(team.score)).every(Number.isFinite)) currentMap = map.name;
    }
  }
  const currentScores = scoreEntries(stateSnapshot.scoreboardNormal, teams);
  const currentScoreSum = currentScores.reduce((sum, item) => sum + item.score, 0);
  const split = selectRoundSegments(segments, staticData.maps.maps, currentMap, currentScoreSum);

  const warnings: DiagnosticWarning[] = mergedStatic.fallbackSections.map((section) => ({
    code: 'RICH_SNAPSHOT_FALLBACK',
    section,
    reason: 'A later snapshot in this capture omitted data that was present earlier in the same capture.',
  }));
  const maps: MatchMap[] = staticData.maps.maps.map((rawMap) => {
    const staticScores = rawMap.teams.map((team) => Number(team.score));
    // Numeric map-card scores during LIVE can be only the completed half, not
    // a final map result. Never classify the active Scorebot map as completed.
    const completed = staticScores.every(Number.isFinite) && (matchOver || rawMap.name !== currentMap);
    const canonicalScore = completed ? rawMap.teams.map((team, index) => ({
      teamId: idFromName(teams, team.name), score: staticScores[index]!,
    })) : rawMap.name === currentMap ? currentScores : [];
    const snapshot = snapshotsByMap.get(rawMap.name);
    const snapshotScores = scoreEntries(snapshot?.scoreboardNormal ?? null, teams);
    const snapshotMatches = snapshot ? scoresMatch(canonicalScore, snapshotScores) : false;
    const combinedSnapshot = snapshot ? combineScoreboards(snapshot.scoreboardNormal, snapshot.scoreboardAdvanced, teams, players) : null;
    const status = completed ? 'completed' : rawMap.name === currentMap ? 'current' : 'upcoming';
    if (snapshot && completed && !snapshotMatches) warnings.push({
      code: 'STALE_SCOREBOARD_OMITTED',
      map: rawMap.name,
      canonicalScore,
      snapshotScore: snapshotScores,
      capturedAt: snapshot.capturedAt,
    });
    const rounds = normalizeRounds(split.assignments.get(rawMap.name) ?? [], players);
    return {
      name: rawMap.name,
      status,
      optional: Boolean(rawMap.optional),
      pickedByTeamId: idFromName(teams, rawMap.teams.find((team) => team.picked)?.name),
      score: canonicalScore,
      halves: parseHalfScores(rawMap.halfScores),
      scoreboard: status !== 'current' && snapshotMatches && snapshot && combinedSnapshot
        ? { capturedAt: snapshot.capturedAt, ...combinedSnapshot }
        : null,
      gameLog: { rounds },
    };
  });

  for (const map of maps) {
    if (map.status === 'completed') {
      const scoreSum = map.score.reduce((sum, item) => sum + item.score, 0);
      const completedRounds = map.gameLog.rounds.filter((round) => round.result).length;
      if (scoreSum !== completedRounds) warnings.push({
        code: 'INCOMPLETE_GAME_LOG',
        map: map.name,
        expectedCompletedRounds: scoreSum,
        capturedCompletedRounds: completedRounds,
        reason: 'No complete Scorebot round sequence could be safely reconciled for the canonical map score.',
      });
    }
  }

  const currentRoundMatch = stateSnapshot.scoreboardNormal?.round.match(/^(\d+)/);
  const consumer: HltvMatch = {
    schemaVersion: '3.1.0',
    capturedAt: snapshot.capturedAt,
    sport: 'cs2',
    source: { provider: 'hltv', url: identity.url },
    match: {
      id: requireId(staticData.match.id, 'match'),
      slug: identity.slug,
      status: staticData.match.status,
      scheduledUnixMs: staticData.match.scheduledUnixMs,
      event: staticData.match.event,
      format: staticData.maps.format,
      stage: staticData.maps.stage,
    },
    teams,
    players,
    lineups,
    veto: normalizeVeto(staticData.maps.veto, teams),
    streams: staticData.streams.map((stream) => ({
      name: stream.name,
      viewers: numberFrom(stream.viewers),
      url: stream.url,
      embedUrl: stream.embedUrl,
    })),
    maps,
    current: !matchOver && stateSnapshot.scoreboardNormal ? {
      capturedAt: stateSnapshot.capturedAt,
      map: currentMap,
      round: currentRoundMatch ? Number(currentRoundMatch[1]) : null,
      score: currentScores,
      scoreboard: combineScoreboards(stateSnapshot.scoreboardNormal, stateSnapshot.scoreboardAdvanced, teams, players),
    } : null,
    matchStats: normalizeMatchStats(staticData.matchStats, teams, players),
    mapStats: normalizeMapStats(staticData.mapStats),
    recentMatches: normalizeRecent(staticData.recentMatches),
    headToHead: normalizeHeadToHead(staticData.headToHead),
  };

  const mapChecks: MatchDiagnostics['mapChecks'] = Object.fromEntries(maps.map((map) => {
    const completedRounds = map.gameLog.rounds.filter((round) => round.result).length;
    const scoreSum = map.score.reduce((sum, item) => sum + item.score, 0);
    return [map.name, {
      status: map.status,
      scoreSum,
      completedRounds,
      consistent: map.status === 'upcoming' || scoreSum === completedRounds,
      scoreboardIncluded: Boolean(map.scoreboard),
    }];
  }));
  const diagnostics: MatchDiagnostics = {
    schemaVersion: '3.0.0',
    operation: 'match-detail',
    startedAt: attempts[0]?.startedAt ?? capture.startedAt,
    completedAt: attempts.at(-1)?.completedAt ?? capture.completedAt,
    durationMs: Math.max(0, Date.parse(attempts.at(-1)?.completedAt ?? capture.completedAt)
      - Date.parse(attempts[0]?.startedAt ?? capture.startedAt)),
    collector: capture.collector,
    input: { id: consumer.match.id, slug: consumer.match.slug, url: consumer.source.url },
    attempts,
    capture: {
      httpStatus: capture.httpStatus,
      navigationSeconds: capture.navigationSeconds,
      totalSeconds: capture.totalSeconds,
      fallbackSections: mergedStatic.fallbackSections,
      scorebot: {
        capturedAt: snapshot.capturedAt,
        httpStatus: snapshot.httpStatus,
        map: mapName(snapshot),
        scoreboardPresent: Boolean(snapshot.scoreboardNormal),
        normalPlayers: snapshot.scoreboardNormal?.teams.flatMap((team) => team.players).length ?? 0,
        advancedPlayers: snapshot.scoreboardAdvanced?.teams.flatMap((team) => team.players).length ?? 0,
        sourceEvents: snapshot.gameLog.chronological.length,
        excludedNonFormalEvents: filtered.excluded + snapshot.gameLog.excludedNoiseEvents,
        adjacentDuplicatesRemoved: deduplicated.removed,
      },
    },
    reconciliation: split.diagnostics,
    mapChecks,
    mergedRecentModes: consumer.recentMatches.views.filter((view) => view.modes.length > 1).map((view) => view.modes),
    warnings,
  };
  return { data: consumer, diagnostics };
}
