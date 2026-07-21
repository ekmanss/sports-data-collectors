import type { HistoricalMatch, TeamPastMatches, TeamRecentMatches } from '../domain/model.js';
import { asArray, asRecord, nullableNumber } from '../internal/value.js';
import {
  arrayOrEmpty,
  historicalMatch,
  historicalTournament,
  percentNumber,
  providerData,
} from './shared.js';

function matchForTeam(match: HistoricalMatch, teamId: string): HistoricalMatch {
  if (!match.teams.some((team) => team.id === teamId)) {
    throw new TypeError('team history match identity mismatch');
  }
  return match;
}

export function parseTeamRecentMatches(
  payload: unknown,
  teamId: string,
): TeamRecentMatches {
  const data = asRecord(providerData(payload, 'team recent matches'), 'team recent data');
  const recent = asRecord(data.rec_matches, 'team recent data.rec_matches');
  const groups = asArray(recent.matches, 'team recent groups').map((entry, groupIndex) => {
    const group = asRecord(entry, `team recent groups[${groupIndex}]`);
    const tournament = historicalTournament(
      group.tt_info,
      `team recent groups[${groupIndex}].tt_info`,
    );
    return {
      matches: arrayOrEmpty(group.matches, `team recent groups[${groupIndex}].matches`).map(
        (match, matchIndex) =>
          matchForTeam(
            historicalMatch(
              match,
              group.tt_info,
              `team recent groups[${groupIndex}].matches[${matchIndex}]`,
            ),
            teamId,
          ),
      ),
      tournament,
    };
  });
  return {
    teamId,
    totalPages: nullableNumber(data.total_page) ?? 0,
    totalRows: nullableNumber(data.total_rows) ?? 0,
    tournaments: groups,
    winRate: percentNumber(data.win_rate),
    winStreak: nullableNumber(data.wins_streak),
  };
}

export function parseTeamPastMatches(payload: unknown, teamId: string): TeamPastMatches {
  const data = asRecord(providerData(payload, 'team past matches'), 'team past data');
  const items = asRecord(data.items, 'team past data.items');
  const matches = asArray(items.matches, 'team past data.items.matches').map((entry, index) => {
    const row = asRecord(entry, `team past match[${index}]`);
    return matchForTeam(
      historicalMatch(row.mc_info, row.tt_info ?? null, `team past match[${index}]`),
      teamId,
    );
  });
  return {
    gamesPlayed: nullableNumber(items.game_played),
    matches,
    teamId,
    totalPages: nullableNumber(data.total_page) ?? 0,
    totalRows: nullableNumber(data.total_rows) ?? 0,
    winRate: percentNumber(items.win_rate),
    winStreak: nullableNumber(items.wins_streak),
  };
}

export function mergeTeamRecentMatches(
  pages: readonly TeamRecentMatches[],
  teamId: string,
): TeamRecentMatches {
  const first = pages[0];
  if (first === undefined) throw new TypeError('team recent history has no pages');
  const tournamentOrder: string[] = [];
  const tournaments = new Map<
    string,
    TeamRecentMatches['tournaments'][number] & { matches: typeof first.tournaments[number]['matches'] }
  >();
  const seenMatches = new Set<string>();
  for (const page of pages) {
    if (page.teamId !== teamId) throw new TypeError('team recent page identity mismatch');
    for (const group of page.tournaments) {
      let merged = tournaments.get(group.tournament.id);
      if (merged === undefined) {
        merged = { matches: [], tournament: group.tournament };
        tournaments.set(group.tournament.id, merged);
        tournamentOrder.push(group.tournament.id);
      }
      const additions = group.matches.filter((match) => {
        if (seenMatches.has(match.id)) return false;
        seenMatches.add(match.id);
        return true;
      });
      merged = { ...merged, matches: [...merged.matches, ...additions] };
      tournaments.set(group.tournament.id, merged);
    }
  }
  return {
    ...first,
    teamId,
    tournaments: tournamentOrder.flatMap((id) => {
      const group = tournaments.get(id);
      return group === undefined ? [] : [group];
    }),
  };
}

export function mergeTeamPastMatches(
  pages: readonly TeamPastMatches[],
  teamId: string,
): TeamPastMatches {
  const first = pages[0];
  if (first === undefined) throw new TypeError('team past history has no pages');
  const seen = new Set<string>();
  const matches = pages.flatMap((page) => {
    if (page.teamId !== teamId) throw new TypeError('team past page identity mismatch');
    return page.matches.filter((match) => {
      if (seen.has(match.id)) return false;
      seen.add(match.id);
      return true;
    });
  });
  return { ...first, matches, teamId };
}
