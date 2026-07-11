import type { CombinedScoreboard, HltvMatch, MatchDiagnostics, ScoreEntry } from '../types.js';
import { link, table } from './markdown_helpers.js';

export function renderMarkdown(match: HltvMatch, diagnostics: MatchDiagnostics): string {
  const teamName = (id: number | null): string => match.teams.find((team) => team.id === id)?.name ?? `team:${id ?? 'unknown'}`;
  const playerName = (id: number | null, fallback?: string): string => match.players.find((player) => player.id === id)?.nickname ?? fallback ?? `player:${id ?? 'unknown'}`;
  const scoreText = (scores: ScoreEntry[]): string => scores.length ? scores.map((item) => `${teamName(item.teamId)} ${item.score}`).join(' — ') : '-';
  const percentage = (value: number | null): string => value === null ? '-' : `${value}%`;
  const sample = (value: { count: number; unit: string } | null): string => value ? `${value.count} ${value.unit}${value.count === 1 ? '' : 's'}` : '-';
  const scoreboardLines = (scoreboard: CombinedScoreboard | null): string[] => {
    if (!scoreboard) return ['- No verified scoreboard is available.', ''];
    const lines: string[] = [];
    if (scoreboard.fact) lines.push(`- Fact: ${scoreboard.fact}`, '');
    for (const team of scoreboard.teams) {
      lines.push(`#### ${teamName(team.teamId)}`, '');
      lines.push(...table(
        ['Player', 'K', 'A', 'FA', 'D', 'ADR', 'Opening duels', 'Multi-kills', 'KAST', 'Clutches', 'HP', 'Money'],
        team.players.map((player) => [
          playerName(player.playerId, player.nickname), player.normal.kills ?? '-', player.normal.assists ?? '-',
          player.normal.flashAssists ?? '-', player.normal.deaths ?? '-', player.normal.adr ?? '-',
          player.advanced.openingDuels ?? '-', player.advanced.multiKills ?? '-', player.advanced.kast ?? '-',
          player.advanced.clutches ?? '-', player.state.health ?? '-', player.state.money ?? '-',
        ]),
      ), '');
    }
    return lines;
  };

  const lines: string[] = [
    `# ${match.teams.map((team) => team.name).join(' vs. ')} — HLTV match data`, '',
    '## Match overview', '',
    `- Match ID: ${match.match.id}`,
    `- Slug: ${match.match.slug}`,
    `- Schema: ${match.schemaVersion}`,
    `- Generated: ${match.generatedAt}`,
    `- Status: ${match.match.status}`,
    `- Scheduled Unix ms: ${match.match.scheduledUnixMs ?? '-'}`,
    `- Event: ${link(match.match.event.name, match.match.event.url)}${match.match.event.id === null ? '' : ` (${match.match.event.id})`}`,
    `- Format: ${match.match.format || '-'}`,
    `- Stage: ${match.match.stage || '-'}`,
    `- Source: ${match.source}`, '',
    '## Teams', '',
    ...table(['ID', 'Team', 'Country', 'Profile'], match.teams.map((team) => [team.id, team.name, team.country ?? '-', link('HLTV', team.url)])), '',
    '## Streams', '',
  ];
  if (match.streams.length) lines.push(...table(['Name', 'Viewers', 'URL', 'Embed'], match.streams.map((stream) => [
    stream.name, stream.viewers ?? '-', link('watch', stream.url), link('embed', stream.embedUrl),
  ])), '');
  else lines.push('- No stream was listed by HLTV at capture time.', '');

  lines.push('## Veto', '');
  if (match.veto.length) lines.push(...match.veto.map((item) => `- ${item.order}. ${item.teamId === null ? '' : `${teamName(item.teamId)} `}${item.action} ${item.map}`), '');
  else lines.push('- No veto was listed by HLTV at capture time.', '');

  lines.push('## Maps', '', ...table(
    ['Map', 'Status', 'Optional', 'Picked by', 'Score', 'Halves', 'Completed rounds'],
    match.maps.map((map) => [
      map.name, map.status, map.optional ? 'yes' : 'no', map.pickedByTeamId === null ? '-' : teamName(map.pickedByTeamId),
      scoreText(map.score), map.halves.map((half) => `${half.team1}:${half.team2}`).join('; ') || '-',
      map.gameLog.rounds.filter((round) => round.result).length,
    ]),
  ), '');

  lines.push('## Current snapshot', '');
  if (match.current) {
    lines.push(`- Captured: ${match.current.capturedAt}`, `- Map: ${match.current.map}`, `- Round: ${match.current.round ?? '-'}`, `- Score: ${scoreText(match.current.score)}`, '');
    lines.push('### Current Normal + Advanced scoreboard', '', ...scoreboardLines(match.current.scoreboard));
  } else lines.push('- No live snapshot is embedded for this match state.', '');

  for (const map of match.maps.filter((item) => item.scoreboard)) {
    lines.push(`### Verified final scoreboard — ${map.name}`, '', `- Captured: ${map.scoreboard!.capturedAt}`, '', ...scoreboardLines(map.scoreboard));
  }

  lines.push('## Lineups and three-month player metrics', '');
  if (!match.lineups.length) lines.push('- No lineup was listed by HLTV at capture time.', '');
  for (const lineup of match.lineups) {
    lines.push(`### ${teamName(lineup.teamId)} — world rank ${lineup.worldRank === null ? '-' : `#${lineup.worldRank}`}`, '');
    const players = lineup.playerIds.map((id) => match.players.find((player) => player.id === id)).filter((player): player is NonNullable<typeof player> => Boolean(player));
    lines.push(...table(
      ['ID', 'Player', 'Full name', 'Country', 'Rating', 'KPR', 'DPR', 'KAST', 'ADR', 'Multi-kill rating', 'Round swing', 'Profile', 'Stats'],
      players.map((player) => [
        player.id, player.nickname, player.fullName ?? '-', player.country ?? '-', player.metrics.rating ?? '-',
        player.metrics.killsPerRound ?? '-', player.metrics.deathsPerRound ?? '-', player.metrics.kastRate ?? '-',
        player.metrics.adr ?? '-', player.metrics.multiKillRating ?? '-', player.metrics.roundSwingRate ?? '-',
        link('profile', player.profileUrl), link('stats', player.statsUrl),
      ]),
    ), '');
  }

  lines.push('## Map stats — past three months', '');
  if (!Object.keys(match.mapStats.metrics).length) lines.push('- No map statistics were listed by HLTV at capture time.', '');
  for (const [metric, rows] of Object.entries(match.mapStats.metrics)) {
    lines.push(`### ${metric.toUpperCase()}`, '');
    lines.push(...table(
      ['Map', ...match.mapStats.teamIds.flatMap((id) => [`${teamName(id)} action`, '%', 'Sample', 'Stats'])],
      rows.map((row) => [row.map, ...row.teams.flatMap((team) => [team.action ?? '-', percentage(team.percentage), sample(team.sample), link('link', team.statsUrl)])]),
    ), '');
  }

  lines.push('## Matches — past three months', '');
  if (!match.recentMatches.views.length) lines.push('- No recent matches were listed by HLTV at capture time.', '');
  for (const view of match.recentMatches.views) {
    lines.push(`### Modes: ${view.modes.join(', ')}`, '');
    for (const team of view.teams) {
      lines.push(`#### ${teamName(team.teamId)}`, '');
      lines.push(...table(['Opponent', 'Country', 'Time ago', 'Format', 'Score', 'Result', 'Match'], team.matches.map((item) => [
        item.opponent.name, item.opponent.country ?? '-', item.timeAgo ?? '-', item.format,
        item.score ? `${item.score.team} - ${item.score.opponent}` : '-', item.result ?? '-', link(String(item.match.id ?? 'link'), item.match.url),
      ])), '');
    }
  }

  lines.push('## Head to head', '');
  if (!match.headToHead.matches.length) lines.push('- No head-to-head match was listed by HLTV.', '');
  else {
    lines.push(`- ${match.headToHead.summary.teams.map((team) => `${teamName(team.teamId)} ${team.wins} wins`).join('; ')}; ${match.headToHead.summary.overtimes} overtimes.`, '');
    for (const item of match.headToHead.matches) {
      lines.push(`### ${item.date} — ${item.event.name}`, '', `- Match: ${link(String(item.id ?? 'link'), item.url)}`, `- Event: ${link(item.event.name, item.event.url)}`,
        `- Lineups: ${item.lineups.map((lineup) => `${teamName(lineup.teamId)}: ${lineup.players.join(', ')}`).join(' | ')}`, '');
      lines.push(...table(['Map', 'Picked', ...item.lineups.map((lineup) => teamName(lineup.teamId))], item.maps.map((map) => [
        map.name, map.picked ? 'yes' : 'no', ...item.lineups.map((lineup) => map.scores.find((score) => score.teamId === lineup.teamId)?.score ?? '-'),
      ])), '');
    }
  }

  for (const map of match.maps) {
    lines.push(`## Formal Game log — ${map.name}`, '');
    if (!map.gameLog.rounds.length) {
      lines.push('- No official round was present at capture time.', '');
      continue;
    }
    for (const round of map.gameLog.rounds) {
      lines.push(`### Round ${round.number}`, '', '- Round started');
      lines.push(...round.events.map((event) => `- ${event.text}`));
      if (round.result) {
        const score = round.result.sideScore ? ` (${round.result.sideScore.ct} - ${round.result.sideScore.t})` : '';
        lines.push(`- Round over — Winner: ${round.result.winnerSide ?? 'unknown'}${score}${round.result.reason ? ` — ${round.result.reason}` : ''}`);
      } else lines.push('- Round in progress at capture time');
      lines.push('');
    }
  }

  lines.push('## Capture warnings', '');
  if (!diagnostics.warnings.length) lines.push('- None.', '');
  else lines.push(...diagnostics.warnings.map((warning) => `- ${warning.code}: ${warning.reason ?? warning.section ?? warning.map ?? 'See diagnostics.json.'}`), '');
  return `${lines.join('\n')}\n`;
}
