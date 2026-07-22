import type {
  ConfirmedMatchObservation,
  DataSection,
  HistoricalMatch,
  MatchAnalysis,
  MatchEvent,
  MatchMap,
  MatchSnapshot,
  MatchState,
  PlayerPowerMetric,
  PlayerStatHighlights,
  PlayerStatRows,
  PlayerState,
  PlayerStatistics,
  UnixMilliseconds,
} from '../domain/model.js';

type MarkdownInput = ConfirmedMatchObservation | MatchSnapshot;

interface RenderContext {
  readonly input: MarkdownInput;
  readonly playerNames: ReadonlyMap<string, string>;
  readonly teamNames: ReadonlyMap<string, string>;
}

type MarkdownHandler = (context: RenderContext) => readonly string[];

function value(value_: string | number | boolean | null | undefined): string {
  if (value_ === null || value_ === undefined || value_ === '') return '—';
  return String(value_)
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\r\n', '<br>')
    .replaceAll('\n', '<br>');
}

function instant(timestamp: UnixMilliseconds | null): string {
  return timestamp === null ? '—' : new Date(timestamp).toISOString();
}

function date(timestamp: UnixMilliseconds | null): string {
  return timestamp === null ? '—' : new Date(timestamp).toISOString().slice(0, 10);
}

function percent(value_: number | null, signed = false): string {
  if (value_ === null) return '—';
  return `${signed && value_ > 0 ? '+' : ''}${value_}%`;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  if (rows.length === 0) return ['_暂无数据_'];
  return [
    `|${headers.map(value).join('|')}|`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => `|${row.map(value).join('|')}|`),
  ];
}

function sparseTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  if (rows.length === 0) return table(headers, rows);
  const retainedIndexes = headers.flatMap((_, index) =>
    rows.some((row) => row[index] !== '—') ? [index] : []);
  const omittedIndexes = headers.flatMap((_, index) =>
    retainedIndexes.includes(index) ? [] : [index]);
  return [
    ...(omittedIndexes.length === 0
      ? []
      : [`- 全表无数据字段：${omittedIndexes.map((index) => headers[index]).join('、')}`, '']),
    ...table(
      retainedIndexes.map((index) => headers[index] ?? '—'),
      rows.map((row) => retainedIndexes.map((index) => row[index] ?? '—')),
    ),
  ];
}

function block(title: string, lines: readonly string[]): string[] {
  return [`## ${title}`, '', ...lines, ''];
}

function subBlock(title: string, lines: readonly string[]): string[] {
  return [`### ${title}`, '', ...lines, ''];
}

function teamName(context: RenderContext, teamId: string | null): string {
  if (teamId === null) return '—';
  return context.teamNames.get(teamId) ?? teamId;
}

function playerName(context: RenderContext, playerId: string | null): string {
  if (playerId === null) return '—';
  return context.playerNames.get(playerId) ?? playerId;
}

function lifecycleSuffix(state: MatchState): string {
  if (state.lifecycle === 'closing') return '（结果待稳定确认）';
  if (state.lifecycle === 'closed') return '（结果已稳定）';
  return '';
}

/** Returns the analysis-facing match stage without exposing provider status codes. */
export function describeMatchState(state: MatchState): string {
  switch (state.phase.kind) {
    case 'prestart':
      return '比赛未开始';
    case 'map-unopened':
      return `比赛已开始，图 ${state.phase.mapNumber} 未开始`;
    case 'map-live':
      return `图 ${state.phase.mapNumber} 进行中`;
    case 'between-maps':
      return `图 ${state.phase.previousMapNumber} 已结束，图 ${state.phase.nextMapNumber} 未开始`;
    case 'series-ended':
      return `比赛已结束，最后进行图 ${state.phase.finalMapNumber}${lifecycleSuffix(state)}`;
  }
}

function mapStatus(map: MatchMap): string {
  switch (map.status) {
    case 'unopened':
      return '未开始';
    case 'live':
      return '进行中';
    case 'settled':
      return '已结束';
    case 'closed-without-play':
      return map.technicalDisposition === 'awarded' ? '裁定结束' : '未进行';
  }
}

function stageName(stage: MatchMap['stage']): string {
  switch (stage) {
    case 'first-half':
      return '上半场';
    case 'second-half':
      return '下半场';
    case 'overtime':
      return '加时';
    case null:
      return '—';
  }
}

function sectionStatus<T>(section: DataSection<T>): string {
  switch (section.status) {
    case 'complete':
      return '完整';
    case 'empty':
      return '无数据';
    case 'partial':
      return '部分数据';
    case 'unavailable':
      return '不可用';
    case 'not-applicable':
      return '不适用';
  }
}

function overviewHandler(context: RenderContext): string[] {
  const { input } = context;
  const [firstTeam, secondTeam] = input.teams;
  const [firstScore, secondScore] = input.seriesScore;
  const tournamentStage = [input.tournament.stage, input.tournament.stageDescription]
    .filter((entry): entry is string => entry !== null && entry !== '')
    .join(' / ');
  return [
    `# ${value(firstTeam.name)} vs ${value(secondTeam.name)}`,
    '',
    `- 比赛 ID：${value(input.match.id)}`,
    `- 当前状态：**${describeMatchState(input.state)}**`,
    `- 系列赛比分：${value(firstTeam.name)} ${firstScore.score}:${secondScore.score} ${value(secondTeam.name)}`,
    `- 赛制：${input.match.format.toUpperCase()}`,
    `- 计划开始：${instant(input.match.scheduledAt)}`,
    `- 数据时间：${instant(input.observedAt)}`,
    `- 赛事：${value(input.tournament.name)}`,
    `- 阶段：${value(tournamentStage)}`,
    `- 地点：${value(input.tournament.location)}`,
    `- 奖金：${value(input.tournament.prize)}`,
    `- 系列赛胜者：${teamName(context, input.seriesWinnerTeamId)}`,
    ...('detailsCompleteness' in input
      ? [`- 详细数据：${input.detailsCompleteness === 'complete' ? '完整' : '部分可用'}`]
      : []),
    '',
  ];
}

function teamsHandler(context: RenderContext): string[] {
  return block(
    '对阵信息',
    table(
      ['战队', '战队 ID', '排名', 'V社排名', 'V社排名变化'],
      context.input.teams.map((team) => [
        team.name,
        team.id,
        value(team.rank),
        value(team.virtualRank),
        team.virtualRankChange === null
          ? '—'
          : `${team.virtualRankChange > 0 ? '+' : ''}${team.virtualRankChange}${team.virtualRankTrend === null ? '' : ` (${team.virtualRankTrend})`}`,
      ]),
    ),
  );
}

function statRows(
  context: RenderContext,
  rows: PlayerStatRows,
): string[] {
  if (rows.rows === null) return ['_数据不可用_'];
  const headers = [
    '选手',
    'Rating',
    'K-D-A',
    'K/D',
    'KD差',
    'KAST',
    'ADR',
    'Swing',
    'KPR',
    'DPR',
    '爆头率',
    '首杀次数',
  ];
  return sparseTable(
    headers,
    rows.rows.map((player) => [
      player.name || playerName(context, player.id),
      value(player.rating),
      `${value(player.kills)}-${value(player.deaths)}-${value(player.assists)}`,
      value(player.killDeathRatio),
      player.kills === null || player.deaths === null
        ? '—'
        : `${player.kills - player.deaths > 0 ? '+' : ''}${player.kills - player.deaths}`,
      percent(player.kastPercent),
      value(player.adr),
      percent(player.swingPercent, true),
      value(player.killsPerRound),
      value(player.deathsPerRound),
      percent(player.headshotPercent),
      value(player.firstKills),
    ]),
  );
}

function hasAdvancedMetrics(player: PlayerState): boolean {
  return [
    player.damagePerRound,
    player.impact,
    player.multiKillRating,
    player.openingKillPercent,
    player.openingKillDifference,
    player.killDeathDifference,
    player.flashAssists,
    player.clutchWins,
    player.multiKillCount,
    player.tradedDeaths,
    player.roundMvpCount,
  ].some((entry) => entry !== null);
}

function advancedStatRows(rows: readonly PlayerState[]): string[] {
  const players = rows.filter(hasAdvancedMetrics);
  if (players.length === 0) return [];
  return [
    '**高级指标**',
    '',
    ...sparseTable(
      [
        '选手',
        'Impact',
        'Multi-kill Rating',
        'Damage/Round',
        'Opening Kill%',
        'Opening差',
        'KD差',
        'Flash Assists',
        'Clutch',
        'Multi-kill',
        'Traded Deaths',
        'Round MVP',
      ],
      players.map((player) => [
        player.name,
        value(player.impact),
        value(player.multiKillRating),
        value(player.damagePerRound),
        percent(player.openingKillPercent),
        value(player.openingKillDifference),
        value(player.killDeathDifference),
        value(player.flashAssists),
        value(player.clutchWins),
        value(player.multiKillCount),
        value(player.tradedDeaths),
        value(player.roundMvpCount),
      ]),
    ),
    '',
  ];
}

function hasLiveState(player: PlayerState): boolean {
  return [
    player.alive,
    player.health,
    player.money,
    player.hasArmor,
    player.helmet,
    player.hasDefuseKit,
  ].some((entry) => entry !== null) || player.equipment.length > 0;
}

function booleanValue(value_: boolean | null): string {
  return value_ === null ? '—' : value_ ? '是' : '否';
}

function liveStateRows(rows: readonly PlayerState[]): string[] {
  const players = rows.filter(hasLiveState);
  if (players.length === 0) return [];
  return [
    '**选手状态快照**',
    '',
    ...sparseTable(
      ['选手', '存活', '生命', '金钱', '护甲', '头盔', '拆弹器', '装备'],
      players.map((player) => [
        player.name,
        booleanValue(player.alive),
        value(player.health),
        value(player.money),
        booleanValue(player.hasArmor),
        booleanValue(player.helmet),
        booleanValue(player.hasDefuseKit),
        player.equipment.length === 0 ? '—' : player.equipment.join(', '),
      ]),
    ),
    '',
  ];
}

function duelRows(context: RenderContext, rows: readonly PlayerState[]): string[] {
  const players = rows.filter((player) =>
    (player.killsByOpponent.rows?.length ?? 0) > 0
    || (player.openingKillsByOpponent.rows?.length ?? 0) > 0);
  if (players.length === 0) return [];
  const opponentIds = [...new Set(players.flatMap((player) => [
    ...(player.killsByOpponent.rows ?? []).map((duel) => duel.opponentPlayerId),
    ...(player.openingKillsByOpponent.rows ?? []).map((duel) => duel.opponentPlayerId),
  ]))];
  const duelValue = (
    duels: NonNullable<PlayerState['killsByOpponent']['rows']>,
    opponentId: string,
  ): string => {
    const duel = duels.find((entry) => entry.opponentPlayerId === opponentId);
    return duel === undefined ? '—' : `${duel.kills}${duel.providerMarkedMost ? '*' : ''}`;
  };
  return [
    '**对位数据**',
    '',
    '- 单元格：击杀/首杀；`*` 表示接口最高标记',
    '',
    ...sparseTable(
      ['选手', ...opponentIds.map((id) => playerName(context, id))],
      players.map((player) => [
        player.name,
        ...opponentIds.map((opponentId) =>
          `${duelValue(player.killsByOpponent.rows ?? [], opponentId)}/${duelValue(player.openingKillsByOpponent.rows ?? [], opponentId)}`),
      ]),
    ),
    '',
  ];
}

function multiKillRows(rows: readonly PlayerState[]): string[] {
  const players = rows.filter((player) => player.multiKills.length > 0);
  if (players.length === 0) return [];
  return [
    '**Multi-kill 分布**',
    '',
    ...sparseTable(
      ['选手', '2K', '3K', '4K', '5K'],
      players.map((player) => [
        player.name,
        ...([2, 3, 4, 5] as const).map((kills) =>
          value(player.multiKills.find((entry) => entry.kills === kills)?.rounds)),
      ]),
    ),
    '',
  ];
}

function statPlaneLines(
  context: RenderContext,
  planeName: string,
  rows: PlayerStatRows,
): string[] {
  if (rows.rows === null) return [`**${planeName}**：_数据不可用_`, ''];
  if (rows.rows.length === 0) return [`**${planeName}**：_暂无数据_`, ''];
  return [
    `**${planeName}**`,
    '',
    ...statRows(context, rows),
    '',
    ...advancedStatRows(rows.rows),
    ...liveStateRows(rows.rows),
    ...duelRows(context, rows.rows),
    ...multiKillRows(rows.rows),
  ];
}

function highlightsLines(
  context: RenderContext,
  highlights: PlayerStatHighlights,
): string[] {
  if (highlights.rows === null) return ['**选手对比**：_数据不可用_', ''];
  if (highlights.rows.length === 0) return [];
  const rows = highlights.rows.flatMap((highlight) =>
    highlight.metrics.map((metric) => [
      highlight.title,
      metric.title,
      value(metric.values[0]),
      value(metric.values[1]),
      `${playerName(context, highlight.leaders[0].playerId)} / ${playerName(context, highlight.leaders[1].playerId)}`,
    ]),
  );
  return [
    '**选手对比**',
    '',
    ...table(
      ['对比项', '指标', context.input.teams[0].name, context.input.teams[1].name, '领先选手'],
      rows,
    ),
    '',
  ];
}

function statisticsLines(
  context: RenderContext,
  statistics: PlayerStatistics,
  teamHeadingLevel: 4 | 5 = 4,
): string[] {
  const lines: string[] = [];
  for (const team of statistics.teams) {
    lines.push(`${'#'.repeat(teamHeadingLevel)} ${value(teamName(context, team.teamId))}`, '');
    lines.push(
      ...statPlaneLines(context, '总体', team.overall),
      ...statPlaneLines(context, 'CT', team.ct),
      ...statPlaneLines(context, 'T', team.t),
    );
  }
  return [...lines, ...highlightsLines(context, statistics.highlights)];
}

interface RoundOutcome {
  readonly reason: string;
  readonly side: 'CT' | 'T';
}

/** 5E round-result codes used by fh_data, sh_data, and ot_data. */
function roundOutcome(code: number): RoundOutcome | null {
  switch (code) {
    case 0:
      return null;
    case 1:
      return { side: 'CT', reason: '歼灭敌人' };
    case 2:
      return { side: 'T', reason: '歼灭敌人' };
    case 3:
      return { side: 'T', reason: '炸弹爆炸' };
    case 4:
      return { side: 'CT', reason: '拆弹获胜' };
    case 5:
      return { side: 'CT', reason: '超时获胜' };
    default:
      return null;
  }
}

function completedRoundCount(
  rounds: readonly [readonly number[], readonly number[]],
  scores: readonly [number | null, number | null],
): number {
  const availableRounds = Math.max(rounds[0].length, rounds[1].length);
  if (availableRounds === 0) return 0;
  const scoreRoundCount = scores[0] === null || scores[1] === null
    ? 0
    : scores[0] + scores[1];
  let lastRecordedRound = 0;
  for (let index = 0; index < availableRounds; index += 1) {
    if ((rounds[0][index] ?? 0) !== 0 || (rounds[1][index] ?? 0) !== 0) {
      lastRecordedRound = index + 1;
    }
  }
  return Math.min(availableRounds, Math.max(scoreRoundCount, lastRecordedRound));
}

function roundTimelineLines(context: RenderContext, map: MatchMap): string[] {
  if (!map.played) return [];
  const [firstTeam, secondTeam] = map.teams;
  const regularHalfLength = map.regulationRoundsPerHalf
    ?? Math.max(firstTeam.firstHalfRounds.length, secondTeam.firstHalfRounds.length);
  const periods = [
    {
      label: '上半场',
      roundStart: 1,
      rounds: [firstTeam.firstHalfRounds, secondTeam.firstHalfRounds] as const,
      scores: [firstTeam.firstHalfScore, secondTeam.firstHalfScore] as const,
      sides: [firstTeam.firstHalfSide, secondTeam.firstHalfSide] as const,
    },
    {
      label: '下半场',
      roundStart: regularHalfLength + 1,
      rounds: [firstTeam.secondHalfRounds, secondTeam.secondHalfRounds] as const,
      scores: [firstTeam.secondHalfScore, secondTeam.secondHalfScore] as const,
      sides: [firstTeam.secondHalfSide, secondTeam.secondHalfSide] as const,
    },
    {
      label: '加时',
      roundStart: regularHalfLength * 2 + 1,
      rounds: [firstTeam.overtimeRounds, secondTeam.overtimeRounds] as const,
      scores: [firstTeam.overtimeScore, secondTeam.overtimeScore] as const,
      sides: [firstTeam.overtimeSide, secondTeam.overtimeSide] as const,
    },
  ];
  const cumulativeScores: [number, number] = [0, 0];
  const rows: string[][] = [];

  for (const period of periods) {
    const roundCount = completedRoundCount(period.rounds, period.scores);
    for (let index = 0; index < roundCount; index += 1) {
      const codes = [period.rounds[0][index] ?? 0, period.rounds[1][index] ?? 0] as const;
      const winnerIndexes = codes.flatMap((code, teamIndex) => code === 0 ? [] : [teamIndex]);
      const roundNumber = period.roundStart + index;
      if (winnerIndexes.length !== 1) {
        rows.push([
          `R${roundNumber}`,
          period.label,
          '胜方未明',
          '—',
          `接口回合数据冲突（${codes[0]}/${codes[1]}）`,
          '—',
        ]);
        continue;
      }

      const winnerIndex = winnerIndexes[0] as 0 | 1;
      const code = codes[winnerIndex];
      const outcome = roundOutcome(code);
      const winningSide = outcome?.side ?? period.sides[winnerIndex];
      cumulativeScores[winnerIndex] += 1;
      rows.push([
        `R${roundNumber}`,
        period.label,
        teamName(context, map.teams[winnerIndex].teamId),
        value(winningSide),
        outcome?.reason ?? `未知获胜方式（接口代码 ${code}）`,
        `${teamName(context, firstTeam.teamId)} ${cumulativeScores[0]}:${cumulativeScores[1]} ${teamName(context, secondTeam.teamId)}`,
      ]);
    }
  }

  return [
    '#### 逐回合结果',
    '',
    ...table(['回合', '阶段', '胜方', '阵营', '获胜方式', '回合后比分'], rows),
    '',
  ];
}

function mapsHandler(context: RenderContext): string[] {
  const lines: string[] = [];
  for (const map of context.input.maps) {
    const names = [map.displayName ?? `图 ${map.mapNumber}`, map.name]
      .filter((entry, index, entries): entry is string =>
        entry !== null && entry !== '' && entries.indexOf(entry) === index);
    const mapTitle = names.join(' / ');
    lines.push(`### ${value(mapTitle)}`, '');
    lines.push(
      `- 状态：${mapStatus(map)}`,
      `- 阶段：${stageName(map.stage)}`,
      `- 当前回合：${value(map.currentRound)}`,
      `- 每半场常规回合：${value(map.regulationRoundsPerHalf)}`,
      `- 开始时间：${instant(map.startedAt)}`,
      `- 结束时间：${instant(map.endedAt)}`,
      `- 当前回合开始：${instant(map.roundStartedAt)}`,
      `- 局内时间（秒）：${value(map.gameTimeSeconds)}`,
      `- 炸弹放置时间：${instant(map.bombPlantedAt)}`,
      `- 胜者：${teamName(context, map.winnerTeamId)}`,
      `- 选图：${value(map.vetoAction)}${map.vetoTeamId === null ? '' : ` / ${teamName(context, map.vetoTeamId)}`}`,
      `- 技术判定：${value(map.technicalDisposition)}`,
      '',
      ...sparseTable(
        [
          '战队',
          '总分',
          'Quick Score',
          '上半场',
          '下半场',
          '加时',
          '当前阵营',
          '上半场阵营',
          '下半场阵营',
          '加时阵营',
          '金钱',
          '装备价值',
          'Flags',
        ],
        map.teams.map((team) => [
          teamName(context, team.teamId),
          value(team.score),
          value(team.quickScore),
          value(team.firstHalfScore),
          value(team.secondHalfScore),
          value(team.overtimeScore),
          value(team.currentSide),
          value(team.firstHalfSide),
          value(team.secondHalfSide),
          value(team.overtimeSide),
          value(team.money),
          value(team.equipmentValue),
          team.flags.length === 0 ? '—' : team.flags.join(', '),
        ]),
      ),
      '',
      ...roundTimelineLines(context, map),
    );
    if (map.played) {
      lines.push(
        '#### 选手数据',
        '',
        ...statisticsLines(context, map.playerStatistics, 5),
      );
    }
  }
  return block('比赛数据', lines.length === 0 ? ['_暂无地图数据_'] : lines);
}

function seriesStatisticsHandler(context: RenderContext): string[] {
  const statistics = context.input.seriesPlayerStatistics;
  const mvp = statistics.mvp;
  return subBlock('数据总览', [
    ...(mvp === null ? [] : [`- MVP：${value(mvp.name)}`, '']),
    ...statisticsLines(context, statistics),
    ...(statistics.mvpChart.length === 0
      ? []
      : [
          '**MVP 指标参考**',
          '',
          ...table(
            ['指标', '平均参考', '上限参考', '展示百分比', '标准化展示值'],
            statistics.mvpChart.map((metric) => [
              metric.key,
              value(metric.averageReference),
              value(metric.upperReference),
              percent(metric.displayPercent),
              value(metric.normalizedDisplay),
            ]),
          ),
          '',
        ]),
  ]);
}

function vetoHandler(context: RenderContext): string[] {
  return block(
    '地图BP',
    table(
      ['顺序', '战队', '动作', '地图'],
      context.input.veto.map((entry, index) => [
        String(index + 1),
        teamName(context, entry.teamId),
        entry.action,
        value(entry.mapName),
      ]),
    ),
  );
}

function historicalMatchRows(
  matches: readonly HistoricalMatch[],
): string[][] {
  return matches.map((match) => {
    const [firstTeam, secondTeam] = match.teams;
    const [firstScore, secondScore] = match.scores;
    const winner = match.winnerTeamId === firstTeam.id
      ? firstTeam.name
      : match.winnerTeamId === secondTeam.id
        ? secondTeam.name
        : '—';
    return [
      date(match.scheduledAt),
      match.tournament?.name ?? '—',
      `${firstTeam.name} ${value(firstScore.score)}:${value(secondScore.score)} ${secondTeam.name}`,
      winner,
      match.format,
    ];
  });
}

function historicalMatches(
  matches: readonly HistoricalMatch[],
): string[] {
  return table(
    ['日期', '赛事', '对阵', '胜者', '赛制'],
    historicalMatchRows(matches),
  );
}

function recentMatches(
  teamId: string,
  matches: readonly HistoricalMatch[],
): string[] {
  return table(
    ['对阵战队', '日期', '赛事', '赛果'],
    matches.map((match) => {
      const teamIndex = match.teams.findIndex((team) => team.id === teamId);
      if (teamIndex < 0) {
        throw new TypeError(`recent match ${match.id} does not contain team ${teamId}`);
      }
      const opponentIndex = teamIndex === 0 ? 1 : 0;
      const teamScore = match.scores[teamIndex]?.score ?? null;
      const opponentScore = match.scores[opponentIndex]?.score ?? null;
      return [
        match.teams[opponentIndex]?.name ?? '—',
        date(match.scheduledAt),
        match.tournament?.name ?? '—',
        `${value(teamScore)}-${value(opponentScore)}`,
      ];
    }),
  );
}

function powerMetricRows(
  metrics: readonly PlayerPowerMetric[],
  depth = 0,
): string[][] {
  return metrics.flatMap((metric) => {
    return [
      [
        `${'↳'.repeat(depth)}${metric.name}`,
        value(metric.score),
        value(metric.guideline),
        value(metric.width),
      ],
      ...powerMetricRows(metric.children, depth + 1),
    ];
  });
}

function playerPowerLines(context: RenderContext, analysis: MatchAnalysis): string[] {
  const lines: string[] = [];
  for (const teamPower of analysis.power) {
    for (const player of teamPower) {
      lines.push(
        `#### ${value(player.playerName)} / ${value(player.teamName ?? teamName(context, player.teamId))}`,
        '',
        `- 阵营：${value(player.sideLabel ?? player.side)}；时间范围：${value(player.timeFrameCode)}；HLTV Rating：${value(player.hltvRating)}`,
        '',
        ...(player.metrics.length === 0
          ? ['_暂无能力指标_']
          : table(['能力指标（`↳` 表示子级）', '分数', '参考线', '宽度'], powerMetricRows(player.metrics))),
        '',
      );
    }
  }
  return lines.length === 0 ? ['_暂无数据_'] : lines;
}

function analysisLines(context: RenderContext, analysis: MatchAnalysis): string[] {
  const teamRows = analysis.teams.map((team) => [
    teamName(context, team.teamId),
    percent(team.winRate),
    value(team.rating),
    value(team.killDeathRatio),
    percent(team.firstSideRate),
    percent(team.secondSideRate),
  ]);
  const mapRows = analysis.maps.flatMap((map) =>
    map.teams.map((team) => [
      map.name,
      map.vetoAction,
      teamName(context, team.teamId),
      value(team.matches),
      value(team.wins),
      percent(team.winRate),
      value(team.picks),
      percent(team.pickRate),
      value(team.bans),
      percent(team.banRate),
    ]),
  );
  const playerRows = analysis.teams.flatMap((team) =>
    team.players.map((player) => [
      teamName(context, team.teamId),
      player.name,
      value(player.rating),
      value(player.killDeathRatio),
      percent(player.kastPercent),
      percent(player.swing, true),
      value(player.adr),
      value(player.killsPerRound),
      value(player.impact),
      value(player.multiKillRating),
    ]),
  );
  const lines: string[] = [
    ...subBlock('选手分析（近三个月数据）', sparseTable(
      [
        '战队',
        '选手',
        'Rating',
        'K/D',
        'KAST',
        'SWING',
        'ADR',
        'KPR',
        'Impact',
        'Multi-kill Rating',
      ],
      playerRows,
    )),
    ...subBlock('选手能力指标', playerPowerLines(context, analysis)),
    ...subBlock('地图分析（近三个月数据）', sparseTable(
      ['地图', '地图BP', '战队', '场次', '胜场', '胜率', 'Pick次数', 'Pick率', 'Ban次数', 'Ban率'],
      mapRows,
    )),
    ...subBlock('战队分析（近三个月数据）', sparseTable(
      ['战队', '胜率（小局）', 'Rating', 'K/D', '上半场手枪局胜率', '下半场手枪局胜率'],
      teamRows,
    )),
  ];
  const recentLines = analysis.recentMatches.flatMap((team) => [
    `#### ${value(teamName(context, team.teamId))}`,
    '',
    ...recentMatches(team.teamId, team.matches),
    '',
  ]);
  lines.push(...subBlock('近期战绩', recentLines));
  const headToHeadRows = analysis.headToHead.winRates.map((entry) => [
    teamName(context, entry.teamId),
    percent(entry.winRate),
  ]);
  lines.push(
    ...subBlock('交手战绩（最近五场）', [
      ...table(['战队', '胜率'], headToHeadRows),
      '',
      ...historicalMatches(analysis.headToHead.matches.slice(0, 5)),
    ]),
  );
  return lines;
}

function renderDataSection<T>(
  title: string,
  section: DataSection<T>,
  render: (data: T) => readonly string[],
): string[] {
  const status = `- 数据状态：${sectionStatus(section)}`;
  if (section.data === null) return block(title, [status]);
  return block(title, [status, '', ...render(section.data)]);
}

function analysisHandler(context: RenderContext): string[] {
  if (!('details' in context.input)) return [];
  return renderDataSection('赛前分析', context.input.details.analysis, (analysis) =>
    analysisLines(context, analysis));
}

interface FormalRoundEvent {
  readonly event: MatchEvent;
  readonly roundNumber: number;
}

function eventAttribute(event: MatchEvent, key: string): string | null {
  const attribute = event.attributes[key];
  return attribute === null || attribute === undefined || attribute === ''
    ? null
    : String(attribute);
}

function trueEventAttribute(event: MatchEvent, key: string): boolean {
  const attribute = event.attributes[key];
  return attribute === true || attribute === 1 || attribute === '1' || attribute === 'true';
}

function eventParticipant(
  context: RenderContext,
  event: MatchEvent,
  playerId: string | null,
  attributeKeys: readonly string[],
): string {
  if (playerId !== null) {
    const knownName = context.playerNames.get(playerId);
    if (knownName !== undefined) return knownName;
  }
  for (const key of attributeKeys) {
    const name = eventAttribute(event, key);
    if (name !== null) return name;
  }
  return playerName(context, playerId);
}

function formalRoundEvents(
  events: readonly MatchEvent[],
  mapNumber: number,
): readonly FormalRoundEvent[] {
  let activeRound: number | null = null;
  const formalEvents: FormalRoundEvent[] = [];
  for (const event of events) {
    if (event.mapNumber !== mapNumber) continue;
    if (event.type === '1') {
      activeRound =
        event.roundNumber !== null &&
        Number.isInteger(event.roundNumber) &&
        event.roundNumber > 0
          ? event.roundNumber
          : null;
      continue;
    }
    if (activeRound === null) continue;
    if (event.type === '2' || event.type === '6' || event.type === '8') {
      formalEvents.push({ event, roundNumber: activeRound });
    }
    if (event.type === '2') activeRound = null;
  }
  return formalEvents;
}

function killEventText(
  context: RenderContext,
  event: MatchEvent,
): string {
  const details: string[] = [];
  if (trueEventAttribute(event, 'head_shot')) details.push('爆头');
  if (trueEventAttribute(event, 'penetrated')) details.push('穿透击杀');
  if (trueEventAttribute(event, 'through_smoke')) details.push('穿烟击杀');
  if (trueEventAttribute(event, 'no_scope')) details.push('未开镜');
  if (trueEventAttribute(event, 'killer_blind')) details.push('致盲状态击杀');
  const assister = eventAttribute(event, 'assist_assister_name')
    ?? eventAttribute(event, 'assist_assister_nick');
  if (assister !== null) {
    const side = eventAttribute(event, 'assist_assister_side');
    details.push(`助攻：${assister}${side === null ? '' : ` (${side})`}`);
  }
  const flasher = eventAttribute(event, 'flasher_nick');
  if (flasher !== null && flasher !== assister) {
    const side = eventAttribute(event, 'flasher_side');
    details.push(`闪光助攻：${flasher}${side === null ? '' : ` (${side})`}`);
  }
  const killer = eventParticipant(
    context,
    event,
    event.actorPlayerId,
    ['killer_name', 'killer_nick'],
  );
  const victim = eventParticipant(
    context,
    event,
    event.targetPlayerId,
    ['victim_name', 'victim_nick'],
  );
  const suffix = [value(eventAttribute(event, 'weapon')), ...details].join('；');
  return `${killer}[${value(eventAttribute(event, 'killer_side'))}] > ${victim}[${value(eventAttribute(event, 'victim_side'))}]（${suffix}）`;
}

function bombPlantEventText(
  context: RenderContext,
  event: MatchEvent,
): string {
  const ctPlayers = eventAttribute(event, 'ct_players');
  const tPlayers = eventAttribute(event, 't_players');
  const player = eventParticipant(
    context,
    event,
    event.actorPlayerId,
    ['player_name', 'player_nick'],
  );
  const survivors = ctPlayers === null && tPlayers === null
    ? ''
    : `（存活 CT ${value(ctPlayers)}/T ${value(tPlayers)}）`;
  return `${player}[T] 放置炸弹@${value(eventAttribute(event, 'bomb_site'))}${survivors}`;
}

function roundEndEventText(event: MatchEvent): string {
  const winner = eventAttribute(event, 'winner');
  const ctScore = eventAttribute(event, 'ct_score');
  const tScore = eventAttribute(event, 't_score');
  const codeValue = event.attributes.win_type_app;
  const code = typeof codeValue === 'number' ? codeValue : Number(codeValue);
  const reason = Number.isFinite(code)
    ? roundOutcome(code)?.reason ?? eventAttribute(event, 'win_type')
    : eventAttribute(event, 'win_type');
  const result = [
    winner === null ? null : `${winner} 获胜`,
    ctScore === null || tScore === null ? null : `比分 CT ${ctScore}:${tScore} T`,
    reason,
  ].filter((entry): entry is string => entry !== null);
  return `回合结束：${result.length === 0 ? '—' : result.join('；')}`;
}

function formalEventText(context: RenderContext, event: MatchEvent): string {
  if (event.type === '8') return killEventText(context, event);
  if (event.type === '6') return bombPlantEventText(context, event);
  return roundEndEventText(event);
}

function formalEventRows(
  context: RenderContext,
  events: readonly FormalRoundEvent[],
): string[][] {
  const groups: Array<{ roundNumber: number; texts: string[] }> = [];
  for (const { event, roundNumber } of events) {
    const current = groups.at(-1);
    if (current?.roundNumber === roundNumber) {
      current.texts.push(formalEventText(context, event));
    } else {
      groups.push({ roundNumber, texts: [formalEventText(context, event)] });
    }
  }
  return groups.map((group) => [
    `R${group.roundNumber}`,
    group.texts.join('<br>'),
  ]);
}

function eventsHandler(context: RenderContext): string[] {
  if (!('details' in context.input)) return [];
  const section = context.input.details.events;
  const lines: string[] = [`- 数据状态：${sectionStatus(section)}`, ''];
  if (section.data !== null) {
    for (const map of context.input.maps) {
      if (!map.played) continue;
      const events = formalRoundEvents(section.data, map.mapNumber);
      if (events.length === 0) continue;
      const names = [map.displayName ?? `图 ${map.mapNumber}`, map.name]
        .filter((entry, index, entries): entry is string =>
          entry !== null && entry !== '' && entries.indexOf(entry) === index);
      lines.push(
        `#### ${value(names.join(' / '))}`,
        '',
        '- 事件按发生顺序；`>` 表示击杀，括号内依次为武器及关键信息',
        '',
        ...table(
          ['回合', '正式事件'],
          formalEventRows(context, events),
        ),
        '',
      );
    }
  }
  if (lines.length === 2) lines.push('_暂无正式回合日志_');
  return subBlock('比赛日志', lines);
}

const MARKDOWN_HANDLERS: readonly MarkdownHandler[] = [
  overviewHandler,
  teamsHandler,
  vetoHandler,
  mapsHandler,
  seriesStatisticsHandler,
  eventsHandler,
  analysisHandler,
];

function createContext(input: MarkdownInput): RenderContext {
  const teamNames = new Map(input.teams.map((team) => [team.id, team.name]));
  const playerNames = new Map<string, string>();
  for (const statistics of [
    input.seriesPlayerStatistics,
    ...input.maps.map((map) => map.playerStatistics),
  ]) {
    for (const team of statistics.teams) {
      for (const plane of [team.overall, team.ct, team.t]) {
        for (const player of plane.rows ?? []) playerNames.set(player.id, player.name);
      }
    }
  }
  return { input, playerNames, teamNames };
}

/** Renders a filtered, analysis-facing Markdown view while leaving the JSON source untouched. */
export function renderMatchMarkdown(input: MarkdownInput): string {
  const context = createContext(input);
  return `${MARKDOWN_HANDLERS.flatMap((handler) => handler(context)).join('\n').trim()}\n`;
}
