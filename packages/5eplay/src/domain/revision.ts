import type {
  ConfirmedMatchObservation,
  MatchMap,
  MatchSnapshot,
  MatchState,
  TeamIdentity,
  TeamScore,
} from './model.js';
import { confirmedRevision } from '../internal/value.js';

interface RevisionObservation {
  readonly match: MatchSnapshot['match'];
  readonly state: MatchState;
  readonly teams: readonly [TeamIdentity, TeamIdentity];
  readonly seriesScore: readonly [TeamScore, TeamScore];
  readonly maps: readonly MatchMap[];
  readonly providerState: ConfirmedMatchObservation['providerState'];
  readonly tournament: Pick<MatchSnapshot['tournament'], 'id'>;
  readonly veto: MatchSnapshot['veto'];
}

export function revisionFor(observation: RevisionObservation) {
  return confirmedRevision({
    closure: observation.state.closure,
    dataFinality: observation.state.dataFinality,
    format: observation.match.format,
    lifecycle: observation.state.lifecycle,
    maps: observation.maps.map((map) => ({
      closedWithoutPlay: map.closedWithoutPlay,
      currentRound: map.currentRound,
      endedAt: map.endedAt,
      mapNumber: map.mapNumber,
      name: map.name,
      orderFinality: map.orderFinality,
      played: map.played,
      providerBoutNumber: map.providerBoutNumber,
      settled: map.settled,
      startedAt: map.startedAt,
      status: map.status,
      teams: map.teams.map((team) => ({
        firstHalfScore: team.firstHalfScore,
        overtimeScore: team.overtimeScore,
        score: team.score,
        secondHalfScore: team.secondHalfScore,
        teamId: team.teamId,
      })),
      winnerTeamId: map.winnerTeamId,
    })),
    phase: observation.state.phase,
    providerState: observation.providerState,
    scheduledAt: observation.match.scheduledAt,
    seriesScore: observation.seriesScore,
    teamIds: observation.teams.map((team) => team.id),
    tournamentId: observation.tournament.id,
    veto: observation.veto.map((entry) => ({
      action: entry.action,
      mapName: entry.mapName,
      teamId: entry.teamId,
    })),
  });
}

export function terminalConsistencyKey(observation: ConfirmedMatchObservation): string {
  return confirmedRevision({
    revision: observation.revision,
    stateVersion: observation.freshness.stateVersion,
  });
}
