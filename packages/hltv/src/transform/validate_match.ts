import { matchIdentityFromUrl } from '../config.js';
import { HltvError } from '../errors.js';
import type { HltvMatch, MatchDiagnostics, RawExtractedPage } from '../types.js';

function fail(message: string, details?: Record<string, unknown>): never {
  throw new HltvError(message, {
    code: 'INCOMPLETE_CAPTURE', operation: 'match-detail', stage: 'validating-output', retryable: false, details,
  });
}

function normalizeNickname(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

export function validateMatch(
  match: HltvMatch,
  diagnostics: MatchDiagnostics,
  raw: Pick<RawExtractedPage, 'sections'>,
  requestedId: number,
): void {
  const scorebotUnavailable = diagnostics.warnings.some(
    (warning) => warning.code === 'SCOREBOT_UNAVAILABLE',
  );
  const identity = matchIdentityFromUrl(match.source.url);
  if (match.schemaVersion !== '3.2.0') fail('unexpected consumer schema version');
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
  const teamIds = new Set(match.teams.map((team) => team.id));
  const playerTeams = new Map<number, number>();
  const nicknameTeamCandidates = new Map<string, Set<number>>();
  for (const lineup of match.lineups) {
    if (!teamIds.has(lineup.teamId)) {
      fail('a lineup references an unknown team', { teamId: lineup.teamId });
    }
    if (lineup.playerIds.some((id) => !playerIds.has(id))) {
      fail('a lineup references an unknown player', { teamId: lineup.teamId });
    }
    const participants = lineup.players ?? lineup.playerIds.flatMap((playerId) => {
      const nickname = match.players.find((player) => player.id === playerId)?.nickname;
      return nickname ? [{ playerId, nickname }] : [];
    });
    const identifiedPlayerIds = participants.flatMap((player) =>
      player.playerId === null ? [] : [player.playerId]);
    if (
      lineup.players
      && JSON.stringify(identifiedPlayerIds) !== JSON.stringify(lineup.playerIds)
    ) {
      fail('a lineup player ID projection is inconsistent', { teamId: lineup.teamId });
    }
    if (identifiedPlayerIds.some((id) => !playerIds.has(id))) {
      fail('a lineup references an unknown player', { teamId: lineup.teamId });
    }
    for (const participant of participants) {
      const nickname = normalizeNickname(participant.nickname);
      if (!nickname) fail('a lineup participant is missing a nickname', { teamId: lineup.teamId });
      const nicknameTeams = nicknameTeamCandidates.get(nickname) ?? new Set<number>();
      nicknameTeams.add(lineup.teamId);
      nicknameTeamCandidates.set(nickname, nicknameTeams);
      if (participant.playerId !== null) {
        const previousTeamId = playerTeams.get(participant.playerId);
        if (previousTeamId !== undefined && previousTeamId !== lineup.teamId) {
          fail('a player belongs to more than one lineup', {
            playerId: participant.playerId,
            teamIds: [previousTeamId, lineup.teamId],
          });
        }
        playerTeams.set(participant.playerId, lineup.teamId);
      }
    }
  }
  const ambiguousNickname = [...nicknameTeamCandidates]
    .find(([, teams]) => teams.size > 1);
  if (ambiguousNickname) {
    fail('a lineup nickname belongs to more than one team', {
      nickname: ambiguousNickname[0],
      teamIds: [...ambiguousNickname[1]],
    });
  }
  const nicknameTeams = new Map(
    [...nicknameTeamCandidates].map(([nickname, teams]) =>
      [nickname, [...teams][0]!] as const),
  );
  for (const view of match.matchStats.views) {
    for (const team of view.teams) {
      if (team.teamId === null || !teamIds.has(team.teamId)) {
        fail('Match stats reference an unknown team', { teamId: team.teamId, team: team.name });
      }
      const unknownPlayer = team.players.find(
        (player) => player.playerId === null || !playerIds.has(player.playerId),
      );
      if (unknownPlayer) {
        fail('Match stats reference an unknown player', {
          playerId: unknownPlayer.playerId,
          player: unknownPlayer.nickname,
        });
      }
    }
  }

  for (const map of match.maps) {
    const completedRounds = map.gameLog.rounds.filter((round) => round.result !== null).length;
    const scoreSum = map.score.reduce((sum, score) => sum + score.score, 0);
    const documentedHistoricalGap = map.status === 'completed' && diagnostics.warnings.some(
      (warning) =>
        warning.code === 'INCOMPLETE_GAME_LOG'
        && warning.map === map.name
        && warning.expectedCompletedRounds === scoreSum
        && warning.capturedCompletedRounds === completedRounds,
    );
    if (
      map.status !== 'upcoming'
      && scoreSum !== completedRounds
      && !scorebotUnavailable
      && !documentedHistoricalGap
    ) {
      fail(`map ${map.name} has ${scoreSum} score rounds but ${completedRounds} completed Game log rounds`, {
        map: map.name,
        scoreSum,
        completedRounds,
      });
    }
    let ctWins = 0;
    let tWins = 0;
    const teamWins = new Map([...teamIds].map((teamId) => [teamId, 0]));
    let teamScoreReliable = teamWins.size === 2;
    map.gameLog.rounds.forEach((round, index) => {
      if (round.number !== index + 1) fail(`map ${map.name} has non-sequential round numbers`);
      if (map.status === 'completed' && round.result === null) {
        fail(`completed map ${map.name} contains an unfinished round`);
      }
      if (round.result?.winnerSide === 'CT') ctWins += 1;
      if (round.result?.winnerSide === 'T') tWins += 1;
      if (
        round.result !== null
        && (
          round.result.sideScore?.ct !== ctWins
          || round.result.sideScore.t !== tWins
        )
      ) {
        fail(`map ${map.name} round ${round.number} has inconsistent side score`, {
          map: map.name,
          round: round.number,
          winnerSide: round.result.winnerSide,
          expected: { ct: ctWins, t: tWins },
          actual: round.result.sideScore,
        });
      }
      if (round.result !== null) {
        const candidates = new Set<number>();
        for (const event of round.events) {
          for (const player of event.players ?? []) {
            const canonicalNickname = player.playerId === null
              ? player.nickname
              : match.players.find((candidate) => candidate.id === player.playerId)?.nickname;
            const expectedTeamId = (player.playerId === null
              ? undefined
              : playerTeams.get(player.playerId))
              ?? nicknameTeams.get(normalizeNickname(canonicalNickname ?? ''))
              ?? null;
            if (player.teamId !== expectedTeamId) {
              fail(`map ${map.name} round ${round.number} has an inconsistent participant team`, {
                map: map.name,
                round: round.number,
                playerId: player.playerId,
                expectedTeamId,
                actualTeamId: player.teamId,
              });
            }
            if (player.side === round.result.winnerSide && player.teamId !== null) {
              candidates.add(player.teamId);
            }
          }
        }
        const expectedWinnerTeamId = candidates.size === 1 ? [...candidates][0]! : null;
        if (round.result.winnerTeamId !== expectedWinnerTeamId) {
          fail(`map ${map.name} round ${round.number} has inconsistent winning team`, {
            map: map.name,
            round: round.number,
            winnerSide: round.result.winnerSide,
            expectedWinnerTeamId,
            actualWinnerTeamId: round.result.winnerTeamId,
          });
        }
        if (expectedWinnerTeamId === null || !teamWins.has(expectedWinnerTeamId)) {
          teamScoreReliable = false;
        } else {
          teamWins.set(expectedWinnerTeamId, teamWins.get(expectedWinnerTeamId)! + 1);
        }
        const expectedTeamScore = teamScoreReliable
          ? [...teamWins].map(([teamId, score]) => ({ teamId, score }))
          : null;
        if (JSON.stringify(round.result.teamScore) !== JSON.stringify(expectedTeamScore)) {
          fail(`map ${map.name} round ${round.number} has inconsistent team score`, {
            map: map.name,
            round: round.number,
            expected: expectedTeamScore,
            actual: round.result.teamScore,
          });
        }
      }
    });
    const latestTeamScore = [...map.gameLog.rounds].reverse().find(
      (round) => round.result !== null,
    )?.result?.teamScore;
    if (
      latestTeamScore
      && scoreSum === completedRounds
      && map.score.length === teamWins.size
      && map.score.some((score) =>
        latestTeamScore.find((entry) => entry.teamId === score.teamId)?.score !== score.score)
    ) {
      fail(`map ${map.name} has a team score that disagrees with its Game log`, {
        map: map.name,
        mapScore: map.score,
        gameLogTeamScore: latestTeamScore,
      });
    }
  }

  for (const scoreboard of [match.current?.scoreboard, ...match.maps.map((map) => map.scoreboard)]) {
    if (!scoreboard) continue;
    const semanticSides = scoreboard.teams.flatMap(
      (team) => team.side === null ? [] : [team.side],
    );
    if (
      semanticSides.length > 0
      && (
        semanticSides.length !== scoreboard.teams.length
        || new Set(semanticSides).size !== semanticSides.length
      )
    ) {
      fail('a scoreboard has incomplete or duplicate semantic sides', { semanticSides });
    }
  }

  if (scorebotUnavailable && match.current !== null) {
    fail('Scorebot-unavailable captures cannot expose a current map');
  }
  if (
    Object.entries(diagnostics.mapChecks).some(([map, check]) =>
      !check.consistent
      && check.status !== 'upcoming'
      && !diagnostics.warnings.some(
        (warning) =>
          warning.code === 'INCOMPLETE_GAME_LOG'
          && warning.map === map
          && warning.expectedCompletedRounds === check.scoreSum
          && warning.capturedCompletedRounds === check.completedRounds,
      ))
    && !scorebotUnavailable
  ) {
    fail('map scores and Game log rounds are inconsistent');
  }
}
