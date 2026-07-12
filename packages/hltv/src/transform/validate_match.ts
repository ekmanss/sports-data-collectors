import { matchIdentityFromUrl } from '../config.js';
import { HltvError } from '../errors.js';
import type { HltvMatch, MatchDiagnostics, RawExtractedPage } from '../types.js';

function fail(message: string, details?: Record<string, unknown>): never {
  throw new HltvError(message, {
    code: 'INCOMPLETE_CAPTURE', operation: 'match-detail', stage: 'validating-output', retryable: false, details,
  });
}

export function validateMatch(
  match: HltvMatch,
  diagnostics: MatchDiagnostics,
  raw: Pick<RawExtractedPage, 'sections'>,
  requestedId: number,
): void {
  const identity = matchIdentityFromUrl(match.source.url);
  if (match.schemaVersion !== '3.0.0') fail('unexpected consumer schema version');
  if (!identity || match.match.id !== requestedId || identity.id !== requestedId || match.match.slug !== identity.slug) {
    fail('match identity is inconsistent with the request', {
      requestedId,
      outputId: match.match.id,
      outputSlug: match.match.slug,
      source: match.source.url,
    });
  }
  if (!raw.sections.matchPage || !raw.sections.maps) fail('required HLTV match sections were not present');
  if (match.teams.length !== 2 || new Set(match.teams.map((team) => team.id)).size !== 2) {
    fail('exactly two unique teams are required');
  }
  if (!match.match.status || !match.match.event.name || !match.match.format || match.maps.length === 0) {
    fail('core match metadata is incomplete');
  }

  const playerIds = new Set(match.players.map((player) => player.id));
  for (const lineup of match.lineups) {
    if (lineup.playerIds.some((id) => !playerIds.has(id))) {
      fail('a lineup references an unknown player', { teamId: lineup.teamId });
    }
  }

  for (const map of match.maps) {
    const completedRounds = map.gameLog.rounds.filter((round) => round.result !== null).length;
    const scoreSum = map.score.reduce((sum, score) => sum + score.score, 0);
    if (map.status !== 'upcoming' && scoreSum !== completedRounds) {
      fail(`map ${map.name} has ${scoreSum} score rounds but ${completedRounds} completed Game log rounds`, {
        map: map.name,
        scoreSum,
        completedRounds,
      });
    }
    map.gameLog.rounds.forEach((round, index) => {
      if (round.number !== index + 1) fail(`map ${map.name} has non-sequential round numbers`);
      if (map.status === 'completed' && round.result === null) {
        fail(`completed map ${map.name} contains an unfinished round`);
      }
    });
  }

  if (Object.values(diagnostics.mapChecks).some((check) => !check.consistent)) {
    fail('map scores and Game log rounds are inconsistent');
  }
}
