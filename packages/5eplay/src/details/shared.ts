import type {
  HistoricalMatch,
  HistoricalTeam,
  HistoricalTournament,
} from '../domain/model.js';
import {
  asArray,
  asRecord,
  asString,
  nullableNumber,
  nullableString,
  secondsToMilliseconds,
} from '../internal/value.js';

export function providerData(payload: unknown, label: string): unknown {
  const envelope = asRecord(payload, label);
  if (envelope.success !== true) throw new TypeError(`${label} was not successful`);
  if (!('data' in envelope)) throw new TypeError(`${label}.data is missing`);
  return envelope.data;
}

export function arrayOrEmpty(value: unknown, label: string): readonly unknown[] {
  return value === null || value === undefined ? [] : asArray(value, label);
}

export function historicalTeam(value: unknown, label: string): HistoricalTeam {
  const team = asRecord(value, label);
  return {
    id: asString(team.id, `${label}.id`),
    logoUrl: nullableString(team.logo),
    name: asString(team.disp_name, `${label}.disp_name`),
  };
}

export function historicalTournament(
  value: unknown,
  label: string,
): HistoricalTournament {
  const tournament = asRecord(value, label);
  return {
    coverUrl: nullableString(tournament.cover),
    gradeCode: nullableString(tournament.grade),
    gradeLabel: nullableString(tournament.grade_label),
    id: asString(tournament.id, `${label}.id`),
    location: nullableString(tournament.city_name) ?? nullableString(tournament.addr),
    logoUrl: nullableString(tournament.logo),
    name: asString(tournament.disp_name, `${label}.disp_name`),
    prize: nullableString(tournament.bonus),
    providerLocalEndTime: nullableString(tournament.end_time),
    providerLocalStartTime: nullableString(tournament.start_time),
    stage: null,
    stageDescription: null,
    status: nullableString(tournament.status),
  };
}

export function historicalMatch(
  value: unknown,
  tournamentValue: unknown | null,
  label: string,
): HistoricalMatch {
  const match = asRecord(value, label);
  const home = historicalTeam(match.home_info, `${label}.home_info`);
  const opponent = historicalTeam(match.opponent_info, `${label}.opponent_info`);
  const homeScore = nullableNumber(match.home_score);
  const opponentScore = nullableNumber(match.opponent_score);
  const winnerTeamId =
    homeScore === null || opponentScore === null || homeScore === opponentScore
      ? null
      : homeScore > opponentScore
        ? home.id
        : opponent.id;
  const mapWinners = arrayOrEmpty(match.bouts_result, `${label}.bouts_result`).map((token) =>
    token === 'home' ? home.id : token === 'opponent' ? opponent.id : null,
  );
  const tournament =
    tournamentValue === null
      ? null
      : {
          ...historicalTournament(tournamentValue, `${label}.tt_info`),
          stage: nullableString(match.tt_stage),
          stageDescription: nullableString(match.tt_stage_desc),
        };
  return {
    format: asString(match.format, `${label}.format`),
    gradeCode: nullableString(match.grade),
    id: asString(match.id, `${label}.id`),
    lifecycle: nullableString(match.status),
    mapWinners,
    providerStatusCode: nullableString(match.match_status),
    scheduledAt: secondsToMilliseconds(match.ts),
    scores: [
      { score: homeScore, teamId: home.id },
      { score: opponentScore, teamId: opponent.id },
    ],
    teams: [home, opponent],
    tournament,
    winnerTeamId,
  };
}

export function percentNumber(value: unknown): number | null {
  return nullableNumber(typeof value === 'string' ? value.replace('%', '') : value);
}
