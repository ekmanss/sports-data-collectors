import { HltvMatchError } from '../errors.js';
import type { HltvMatch, MatchDiagnostics, NormalizedGetHltvMatchOptions, RawExtractedPage } from '../types.js';

function fail(message: string, details?: Record<string, unknown>): never {
  throw new HltvMatchError(message, {
    code: 'INCOMPLETE_CAPTURE', stage: 'validating-output', retryable: false, details,
  });
}

export function sensitiveTextHits(text: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ['credential-keyword', /cookie|authorization|bearer|password|api[_-]?key|access[_-]?token|refresh[_-]?token/i],
    ['local-user-path', /\/Users\//i],
  ];
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export function validateMatch(
  match: HltvMatch,
  diagnostics: MatchDiagnostics,
  raw: RawExtractedPage,
  options: NormalizedGetHltvMatchOptions,
  markdown: string,
  chineseReport: string,
): void {
  if (match.schemaVersion !== '2.1.0') fail('unexpected consumer schema version');
  if (match.match.id !== options.id || match.match.slug !== options.slug || match.source !== options.url) {
    fail('match identity is inconsistent with the request', {
      requestedId: options.id, outputId: match.match.id, requestedSlug: options.slug, outputSlug: match.match.slug,
    });
  }
  if (!raw.sections.matchPage || !raw.sections.maps) fail('required HLTV match sections were not present');
  if (match.teams.length !== 2 || new Set(match.teams.map((team) => team.id)).size !== 2) fail('exactly two unique teams are required');
  if (!match.match.status || !match.match.event.name || !match.match.format || match.maps.length === 0) {
    fail('core match metadata is incomplete');
  }
  const playerIds = new Set(match.players.map((player) => player.id));
  for (const lineup of match.lineups) {
    if (lineup.playerIds.some((id) => !playerIds.has(id))) fail('a lineup references an unknown player', { teamId: lineup.teamId });
  }
  for (const map of match.maps) {
    const completedRounds = map.gameLog.rounds.filter((round) => round.result !== null).length;
    const scoreSum = map.score.reduce((sum, score) => sum + score.score, 0);
    if (map.status !== 'upcoming' && scoreSum !== completedRounds) {
      fail(`map ${map.name} has ${scoreSum} score rounds but ${completedRounds} completed Game log rounds`, { map: map.name, scoreSum, completedRounds });
    }
    map.gameLog.rounds.forEach((round, index) => {
      if (round.number !== index + 1) fail(`map ${map.name} has non-sequential round numbers`);
      if (map.status === 'completed' && round.result === null) fail(`completed map ${map.name} contains an unfinished round`);
    });
  }
  if (!diagnostics.consumerAudit.allCompletedMapScoresConsistent) fail('completed map scores and Game log rounds are inconsistent');
  if (diagnostics.consumerAudit.forbiddenKeyHits.length) fail('consumer contains forbidden internal fields', { hits: diagnostics.consumerAudit.forbiddenKeyHits });
  const sensitiveHits = new Set([
    ...diagnostics.consumerAudit.sensitiveValueHits,
    ...sensitiveTextHits(markdown),
    ...sensitiveTextHits(chineseReport),
  ]);
  diagnostics.consumerAudit.sensitiveValueHits = [...sensitiveHits];
  if (sensitiveHits.size) fail('public outputs contain sensitive values', { hits: [...sensitiveHits] });
}
