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
  PlayerStatHighlight,
  PlayerStatHighlights,
  PlayerStatRows,
  PlayerState,
  PlayerStatistics,
  UnixMilliseconds,
} from '../domain/model.js';

type MarkdownInput = ConfirmedMatchObservation | MatchSnapshot;

interface RenderContext {
  readonly input: MarkdownInput;
  readonly playerAliases: ReadonlyMap<string, string>;
  readonly playerNames: ReadonlyMap<string, string>;
  readonly teamNames: ReadonlyMap<string, string>;
}

type MarkdownHandler = (context: RenderContext) => readonly string[];

function value(value_: string | number | boolean | null | undefined): string {
  const normalized = typeof value_ === 'string' ? value_.trim() : value_;
  if (normalized === null || normalized === undefined || normalized === '') return '—';
  return String(normalized)
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
  return table(
    retainedIndexes.map((index) => headers[index] ?? '—'),
    rows.map((row) => retainedIndexes.map((index) => row[index] ?? '—')),
  );
}

function block(title: string, lines: readonly string[]): string[] {
  return [`## ${title}`, '', ...lines, ''];
}

function subBlock(title: string, lines: readonly string[]): string[] {
  return [`### ${title}`, '', ...lines, ''];
}

function teamName(context: RenderContext, teamId: string | null): string {
  if (teamId === null) return '—';
  return value(context.teamNames.get(teamId) ?? teamId);
}

function playerName(context: RenderContext, playerId: string | null): string {
  if (playerId === null) return '—';
  return value(context.playerNames.get(playerId) ?? playerId);
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
      return `比赛已结束，共进行 ${state.phase.finalMapNumber} 张地图${lifecycleSuffix(state)}`;
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

function mapVetoLabel(context: RenderContext, map: MatchMap): string {
  if (map.vetoAction === 'left') return 'decider（剩余决胜图）';
  if (map.vetoAction !== 'pick') return '—';
  return `pick${map.vetoTeamId === null ? '' : ` / ${teamName(context, map.vetoTeamId)}`}`;
}

function liveInstant(
  timestamp: UnixMilliseconds | null,
  observedAt: UnixMilliseconds,
): string {
  if (timestamp === null) return '—';
  return timestamp > observedAt
    ? '—（接口时间晚于快照，已忽略）'
    : instant(timestamp);
}

function sectionStatus<T>(section: DataSection<T>): string {
  const status = (() => {
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
  })();
  return section.gap === null
    ? status
    : `${status}（缺口：\`${section.gap.replaceAll('`', '')}\`）`;
}

function tournamentStage(
  stage: string | null,
  description: string | null,
): string | null {
  if (description !== null && description !== '') return description;
  return stage;
}

function rankValue(rank: number | null): string {
  return rank === 0 ? '未排名' : value(rank);
}

function virtualRankChange(
  change: number | null,
  trend: 'up' | 'down' | null,
): string {
  if (change === null) return '—';
  if (trend === 'up') return `上升 ${Math.abs(change)} 名`;
  if (trend === 'down') return `下降 ${Math.abs(change)} 名`;
  return value(change);
}

function overviewHandler(context: RenderContext): string[] {
  const { input } = context;
  const [firstTeam, secondTeam] = input.teams;
  const [firstScore, secondScore] = input.seriesScore;
  return [
    `# ${value(firstTeam.name)} vs ${value(secondTeam.name)}`,
    '',
    `- 比赛 ID：${value(input.match.id)}`,
    `- 当前状态：**${describeMatchState(input.state)}**`,
    `- 系列赛比分：${value(firstTeam.name)} ${firstScore.score}:${secondScore.score} ${value(secondTeam.name)}`,
    `- 赛制：${input.match.format.toUpperCase()}`,
    `- 游戏：${input.match.gameVersion.toUpperCase()}`,
    `- 计划开始（UTC）：${instant(input.match.scheduledAt)}`,
    `- 快照采集时间（UTC）：${instant(input.observedAt)}`,
    `- 赛事：${value(input.tournament.name)}`,
    `- 赛事级别：${value(input.tournament.gradeLabel)}`,
    `- 阶段：${value(tournamentStage(input.tournament.stage, input.tournament.stageDescription))}`,
    `- 地点：${value(input.tournament.location)}`,
    `- 奖励/奖金：${value(input.tournament.prize)}`,
    `- 系列赛胜者：${teamName(context, input.seriesWinnerTeamId)}`,
    ...('detailsCompleteness' in input
      ? [`- 详细数据采集：${input.detailsCompleteness === 'complete' ? '完整' : '部分可用'}`]
      : []),
    '- 缺失值：`—` 表示接口未提供或当前状态不适用，不等于 0；采集完整不表示每个字段都有值',
    '',
  ];
}

function teamsHandler(context: RenderContext): string[] {
  return block(
    '对阵信息',
    table(
      ['战队', '战队 ID', '排名（接口）', 'V社排名', 'V社排名变化'],
      context.input.teams.map((team) => [
        team.name,
        team.id,
        rankValue(team.rank),
        rankValue(team.virtualRank),
        virtualRankChange(team.virtualRankChange, team.virtualRankTrend),
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
    '5E SWING',
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
      value(player.adr ?? player.damagePerRound),
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
  const showImpact = players.some((player) => player.impact !== null && player.impact !== 0);
  return [
    '**高级指标**',
    '',
    ...sparseTable(
      [
        '选手',
        'Impact',
        'Multi-kill Rating（5E）',
        'Opening Kill%（回合占比）',
        'Opening差（首杀-首死）',
        'KD差',
        'Flash Assists（次数）',
        'Clutch Wins',
        'Multi-kill Rounds',
        'Traded Deaths',
        'Round MVP',
      ],
      players.map((player) => [
        player.name,
        showImpact ? value(player.impact) : '—',
        value(player.multiKillRating),
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
        player.equipment.length === 0
          ? '—'
          : player.equipment.map((equipment) => weaponName(equipment)).join(', '),
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
  const players = rows.filter((player) =>
    player.multiKills.some((entry) => entry.rounds !== null));
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
  const metricSummary = (highlight: PlayerStatHighlight, index: 0 | 1) =>
    highlight.metrics
      .map((metric) => `${metric.title} ${value(metric.values[index])}`)
      .join('；');
  const rows = highlights.rows.map((highlight) => [
    highlight.title,
    playerName(context, highlight.leaders[0].playerId),
    metricSummary(highlight, 0),
    playerName(context, highlight.leaders[1].playerId),
    metricSummary(highlight, 1),
  ]);
  return [
    '**选手对比**',
    '',
    '- 代表选手由整个对比项确定；同一项内的其他数值是该选手的附属指标，不表示各指标分别为队内最高',
    '',
    ...table(
      [
        '对比项',
        `${context.input.teams[0].name} 代表选手`,
        `${context.input.teams[0].name} 数据`,
        `${context.input.teams[1].name} 代表选手`,
        `${context.input.teams[1].name} 数据`,
      ],
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
        `${cumulativeScores[0]}:${cumulativeScores[1]}`,
      ]);
    }
  }

  return [
    '#### 逐回合结果',
    '',
    ...table([
      '回合',
      '阶段',
      '胜方',
      '胜方当回合阵营',
      '获胜方式',
      `比分（${teamName(context, firstTeam.teamId)}:${teamName(context, secondTeam.teamId)}）`,
    ], rows),
    '',
  ];
}

function mapsHandler(context: RenderContext): string[] {
  const lines: string[] = [
    '- 统计口径：KAST=发生击杀、助攻、存活或死亡被补枪的回合占比；ADR/KPR/DPR=每回合平均伤害/击杀/死亡；Opening Kill%=首杀回合占比；Opening差=首杀数-首死数；Multi-kill=多杀回合数；Traded Deaths=死亡后被队友补枪次数',
    '- `5E SWING` 与 `Multi-kill Rating（5E）` 保留接口口径，不与 HLTV Rating 混用',
    '',
  ];
  for (const map of context.input.maps) {
    const names = [map.displayName ?? `图 ${map.mapNumber}`, map.name]
      .filter((entry, index, entries): entry is string =>
        entry !== null && entry !== '' && entries.indexOf(entry) === index);
    const mapTitle = names.join(' / ');
    lines.push(`### ${value(mapTitle)}`, '');
    const veto = mapVetoLabel(context, map);
    if (map.status === 'closed-without-play' && map.technicalDisposition === 'unused') {
      lines.push(
        '- 状态：未进行（决胜图；系列赛提前结束）',
        `- 本场 BP：${veto}`,
        '',
      );
      continue;
    }
    lines.push(`- 状态：${mapStatus(map)}`);
    if (map.status === 'live') {
      lines.push(
        `- 当前阶段：${stageName(map.stage)}`,
        `- 当前回合：${value(map.currentRound)}`,
        `- 赛制：MR${value(map.regulationRoundsPerHalf)}`,
        `- 开始时间（UTC）：${liveInstant(map.startedAt, context.input.observedAt)}`,
        `- 当前回合开始（UTC）：${liveInstant(map.roundStartedAt, context.input.observedAt)}`,
        ...(map.gameTimeSeconds === null || map.gameTimeSeconds <= 0
          ? []
          : [`- 回合计时（秒）：${value(map.gameTimeSeconds)}`]),
        `- 炸弹放置时间（UTC）：${liveInstant(map.bombPlantedAt, context.input.observedAt)}`,
      );
    } else if (map.status === 'settled') {
      lines.push(
        `- 正式回合数：${value(map.currentRound)}`,
        `- 赛制：MR${value(map.regulationRoundsPerHalf)}`,
        `- 开始时间（UTC）：${instant(map.startedAt)}`,
        `- 结束时间（UTC）：${instant(map.endedAt)}`,
        `- 胜者：${teamName(context, map.winnerTeamId)}`,
      );
    } else {
      lines.push(`- 赛制：MR${value(map.regulationRoundsPerHalf)}`);
      if (map.technicalDisposition === 'awarded') {
        lines.push(
          '- 技术判定：awarded（技术判胜）',
          `- 胜者：${teamName(context, map.winnerTeamId)}`,
        );
      }
    }
    lines.push(`- 本场 BP：${veto}`, '');
    if (map.played || map.technicalDisposition === 'awarded') {
      const live = map.status === 'live';
      lines.push(
        ...sparseTable(
          live
            ? [
                '战队', '正式比分', '即时比分（接口遥测）', '上半场', '下半场', '加时',
                '当前阵营', '上半场阵营', '下半场阵营', '加时阵营', '金钱', '装备价值',
              ]
            : [
                '战队', '最终比分', '上半场', '下半场', '加时',
                '上半场阵营', '下半场阵营', '加时阵营',
              ],
          map.teams.map((team) => live
            ? [
                teamName(context, team.teamId), value(team.score), value(team.quickScore),
                value(team.firstHalfScore), value(team.secondHalfScore), value(team.overtimeScore),
                value(team.currentSide), value(team.firstHalfSide), value(team.secondHalfSide),
                value(team.overtimeSide), value(team.money), value(team.equipmentValue),
              ]
            : [
                teamName(context, team.teamId), value(team.score), value(team.firstHalfScore),
                value(team.secondHalfScore), value(team.overtimeScore), value(team.firstHalfSide),
                value(team.secondHalfSide), value(team.overtimeSide),
              ]),
        ),
        '',
      );
    }
    lines.push(...roundTimelineLines(context, map));
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
    '- 统计范围：已进行地图的系列赛合计',
    '',
    ...(mvp === null ? [] : [`- MVP：${value(mvp.name)}`, '']),
    ...statisticsLines(context, statistics),
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
        entry.action === 'left' ? 'decider（剩余地图）' : entry.action,
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
  const signature = (match: HistoricalMatch): string => {
    const teamIndex = match.teams.findIndex((team) => team.id === teamId);
    const opponentIndex = teamIndex === 0 ? 1 : 0;
    return [
      match.teams[opponentIndex]?.name,
      date(match.scheduledAt),
      match.tournament?.name,
      match.scores[teamIndex]?.score,
      match.scores[opponentIndex]?.score,
    ].join('|');
  };
  const signatureCounts = new Map<string, number>();
  for (const match of matches) {
    const key = signature(match);
    signatureCounts.set(key, (signatureCounts.get(key) ?? 0) + 1);
  }
  return table(
    ['对阵战队', '日期', '赛事', '赛果（本节战队:对手）'],
    matches.map((match) => {
      const teamIndex = match.teams.findIndex((team) => team.id === teamId);
      if (teamIndex < 0) {
        throw new TypeError(`recent match ${match.id} does not contain team ${teamId}`);
      }
      const opponentIndex = teamIndex === 0 ? 1 : 0;
      const teamScore = match.scores[teamIndex]?.score ?? null;
      const opponentScore = match.scores[opponentIndex]?.score ?? null;
      const opponent = match.teams[opponentIndex]?.name ?? '—';
      return [
        (signatureCounts.get(signature(match)) ?? 0) > 1
          ? `${opponent}（${match.id}）`
          : opponent,
        date(match.scheduledAt),
        match.tournament?.name ?? '—',
        `${value(teamScore)}-${value(opponentScore)}`,
      ];
    }),
  );
}

interface MatrixPowerMetric {
  readonly depth: number;
  readonly key: string;
  readonly name: string;
  readonly occurrence: number;
  readonly score: string | null;
}

function powerMetricName(metric: MatrixPowerMetric): string {
  switch (metric.key.split('/').at(-1)?.split('#')[0]) {
    case 'traded_deaths_per_round':
      return '每回合被队友补枪的死亡数';
    case 'sniper_multi-kill_rounds':
      return '每回合狙击多杀数';
    case 'time_opponent_flashed_per_round':
      return '每回合闪白对手时间（秒）';
    default:
      return metric.name;
  }
}

function powerMetricScore(metric: MatrixPowerMetric): string {
  if (metric.score === null) return '—';
  const key = metric.key.split('/').at(-1)?.split('#')[0];
  if (key === 'time_alive_per_round') {
    const time = /^(\d+)'(\d{2})$/.exec(metric.score);
    if (time !== null) return `${time[1]}m${time[2]}s`;
  }
  if (
    metric.score === '0'
    && (
      /(?:percentage|_rate$|win%)/.test(key ?? '')
      || /(?:率|占比|百分比)$/.test(metric.name)
    )
  ) return '0%';
  return value(metric.score);
}

function matrixPowerMetrics(
  metrics: readonly PlayerPowerMetric[],
  hltvRating: number | null,
  parentKey = '',
  depth = 0,
): MatrixPowerMetric[] {
  const occurrences = new Map<string, number>();
  return metrics.flatMap((metric) => {
    const occurrence = (occurrences.get(metric.key) ?? 0) + 1;
    occurrences.set(metric.key, occurrence);
    const score = metric.score === null ? Number.NaN : Number(metric.score);
    const mislabeledRatingDuplicate =
      metric.key === 'kills_per_round_win'
      && occurrence > 1
      && hltvRating !== null
      && Number.isFinite(score)
      && score === hltvRating;
    if (mislabeledRatingDuplicate) return [];
    const segment = `${metric.key}#${occurrence}`;
    const key = parentKey === '' ? segment : `${parentKey}/${segment}`;
    return [{
      depth,
      key,
      name: metric.name,
      occurrence,
      score: metric.score,
    }, ...matrixPowerMetrics(metric.children, hltvRating, key, depth + 1)];
  });
}

function playerPowerLines(context: RenderContext, analysis: MatchAnalysis): string[] {
  const players = analysis.power.flatMap((group, teamIndex) =>
    group.map((player) => ({
      ...player,
      matchTeamId: context.input.teams[teamIndex]?.id ?? null,
    })));
  if (players.length === 0) return ['_暂无数据_'];
  const duplicateNames = new Set(players.flatMap((player, index) =>
    players.some((other, otherIndex) =>
      otherIndex !== index && other.playerName === player.playerName)
      ? [player.playerName]
      : []));
  const playerLabels = players.map((player) => duplicateNames.has(player.playerName)
    ? `${player.playerName} (${teamName(context, player.matchTeamId)})`
    : player.playerName);
  const metricsByPlayer = players.map((player) =>
    matrixPowerMetrics(player.metrics, player.hltvRating));
  const metricDefinitions = new Map<
    string,
    { depth: number; name: string; occurrence: number }
  >();
  for (const metrics of metricsByPlayer) {
    for (const metric of metrics) {
      if (!metricDefinitions.has(metric.key)) {
        metricDefinitions.set(metric.key, {
          depth: metric.depth,
          name: metric.name,
          occurrence: metric.occurrence,
        });
      }
    }
  }
  const metricMaps = metricsByPlayer.map((metrics) =>
    new Map(metrics.map((metric) => [metric.key, metric])));
  const metricRows = [...metricDefinitions].map(([key, definition]) => {
    const occurrenceSuffix = definition.occurrence === 1
      ? ''
      : `（${definition.occurrence}）`;
    const displayName = powerMetricName({
      depth: definition.depth,
      key,
      name: definition.name,
      occurrence: definition.occurrence,
      score: null,
    });
    return [
      `${'↳'.repeat(definition.depth)}${displayName}${occurrenceSuffix}`,
      ...metricMaps.map((metrics) => {
        const metric = metrics.get(key);
        return metric === undefined ? '—' : powerMetricScore(metric);
      }),
    ];
  });
  const timeFrames = [...new Set(players.map((player) => player.timeFrameCode).filter(
    (entry): entry is string => entry !== null,
  ))];
  const timeFrame = timeFrames.length === 1 && timeFrames[0] === '3'
    ? '近 3 个月'
    : timeFrames.map(value).join('、') || '接口未说明';
  const sides = [...new Set(players.map((player) => player.sideLabel ?? player.side).filter(
    (entry): entry is string => entry !== null,
  ))];
  return [
    `- 统计范围：${timeFrame}；${sides.join('、') || '阵营范围未说明'}`,
    '- `Rating（5E）` 与 `HLTV Rating` 来自不同接口字段，不可直接互换',
    '- “资料所属队”来自选手资料，可能是俱乐部或历史归属；“本场战队”才是本场阵容',
    '',
    ...table(
      ['选手', '本场战队', '资料所属队', 'HLTV Rating'],
      players.map((player) => [
        player.playerName,
        teamName(context, player.matchTeamId),
        player.teamName === teamName(context, player.matchTeamId)
          ? '—'
          : value(player.teamName),
        value(player.hltvRating),
      ]),
    ),
    '',
    '- 无 `↳` 的行是 5E 综合能力分（0–100）；`↳` 是上方能力维度的原始明细指标，各行单位不同',
    '',
    ...(metricRows.length === 0
      ? ['_暂无能力指标_']
      : table(['能力指标', ...playerLabels], metricRows)),
  ];
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
  const mapTeamIds = context.input.teams.map((team) => team.id);
  const mapRows = analysis.maps.map((map) => [
    map.name,
    map.vetoAction === 'left'
      ? 'decider'
      : map.vetoAction === 'pick'
        ? `pick${map.vetoTeamId === null ? '' : `（${teamName(context, map.vetoTeamId)}）`}`
        : '—',
    ...mapTeamIds.map((teamId) => {
      const team = map.teams.find((entry) => entry.teamId === teamId);
      return team === undefined
        ? '—'
        : [
            value(team.matches),
            percent(team.winRate),
            value(team.picks),
            percent(team.pickRate),
            value(team.bans),
            percent(team.banRate),
          ].join('/');
    }),
  ]);
  const showImpact = analysis.teams.some((team) =>
    team.players.some((player) => player.impact !== null && player.impact !== 0));
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
      showImpact ? value(player.impact) : '—',
      value(player.multiKillRating),
    ]),
  );
  const lines: string[] = [
    ...subBlock('选手分析（近三个月数据）', sparseTable(
      [
        '战队',
        '选手',
        'Rating（5E）',
        'K/D',
        'KAST',
        '5E SWING',
        'ADR',
        'KPR',
        'Impact',
        'Multi-kill Rating（5E）',
      ],
      playerRows,
    )),
    ...subBlock('选手能力指标', playerPowerLines(context, analysis)),
    ...subBlock('地图分析（近三个月数据）', [
      '- 战队单元格：场次/胜率/Pick次数/Pick率/Ban次数/Ban率；Pick/Ban率按 5E 近三个月统计口径',
      '',
      ...sparseTable(
        ['地图', '本场BP', ...mapTeamIds.map((teamId) => teamName(context, teamId))],
        mapRows,
      ),
    ]),
    ...subBlock('战队分析（近三个月数据）', sparseTable(
      ['战队', '胜率（小局）', 'Rating（5E）', 'K/D', '上半场手枪局胜率', '下半场手枪局胜率'],
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
  const hasHeadToHeadRates = analysis.headToHead.winRates.some(
    (entry) => entry.winRate !== null,
  );
  const headToHeadLines = [
    ...(hasHeadToHeadRates ? [...table(['战队', '胜率'], headToHeadRows), ''] : []),
    ...(analysis.headToHead.matches.length === 0
      ? [hasHeadToHeadRates
          ? '_接口仅返回汇总胜率，未返回比赛明细；样本数未知。_'
          : '_接口未返回交手汇总或比赛明细。_']
      : historicalMatches(analysis.headToHead.matches.slice(0, 5))),
  ];
  lines.push(
    ...subBlock('交手战绩（最近五场）', headToHeadLines),
  );
  return lines;
}

function renderDataSection<T>(
  title: string,
  section: DataSection<T>,
  render: (data: T) => readonly string[],
): string[] {
  const status = `- 采集状态：${sectionStatus(section)}`;
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
    if (name !== null) return canonicalPlayerName(context, name);
  }
  return playerName(context, playerId);
}

function normalizedPlayerAlias(name: string): string {
  return name.toLocaleLowerCase('en-US').replaceAll(/[^a-z0-9]/g, '');
}

function canonicalPlayerName(context: RenderContext, name: string): string {
  return value(context.playerAliases.get(normalizedPlayerAlias(name)) ?? name);
}

function eventSide(side: string | null): string | null {
  if (side === null) return null;
  const normalized = side.toUpperCase().replaceAll(/[^A-Z]/g, '');
  if (normalized === 'T' || normalized === 'TERRORIST') return 'T';
  if (normalized === 'CT' || normalized === 'COUNTERTERRORIST') return 'CT';
  return side;
}

function weaponName(weapon: string | null): string {
  if (weapon === null) return '—';
  const normalized = weapon.trim().toLowerCase().replace(/^weapon_/, '');
  const names: Readonly<Record<string, string>> = {
    ak47: 'AK-47',
    aug: 'AUG',
    awp: 'AWP',
    bayonet: 'Bayonet',
    bizon: 'PP-Bizon',
    cz75a: 'CZ75-Auto',
    deagle: 'Desert Eagle',
    decoy: 'Decoy Grenade',
    elite: 'Dual Berettas',
    famas: 'FAMAS',
    fiveseven: 'Five-SeveN',
    flashbang: 'Flashbang',
    g3sg1: 'G3SG1',
    galilar: 'Galil AR',
    glock: 'Glock-18',
    hegrenade: 'HE Grenade',
    hkp2000: 'P2000',
    inferno: 'Incendiary fire',
    knife: 'Knife',
    knife_butterfly: 'Butterfly Knife',
    knife_cord: 'Paracord Knife',
    knife_css: 'Classic Knife',
    knife_falchion: 'Falchion Knife',
    knife_flip: 'Flip Knife',
    knife_gut: 'Gut Knife',
    knife_gypsy_jackknife: 'Navaja Knife',
    knife_karambit: 'Karambit',
    knife_kukri: 'Kukri Knife',
    knife_m9_bayonet: 'M9 Bayonet',
    knife_outdoor: 'Nomad Knife',
    knife_push: 'Shadow Daggers',
    knife_skeleton: 'Skeleton Knife',
    knife_stiletto: 'Stiletto Knife',
    knife_survival_bowie: 'Bowie Knife',
    knife_tactical: 'Huntsman Knife',
    knife_ursus: 'Ursus Knife',
    knife_widowmaker: 'Talon Knife',
    m4a1: 'M4A4',
    m4a1_silencer: 'M4A1-S',
    mac10: 'MAC-10',
    mag7: 'MAG-7',
    molotov: 'Molotov',
    mp5sd: 'MP5-SD',
    mp7: 'MP7',
    mp9: 'MP9',
    negev: 'Negev',
    nova: 'Nova',
    p250: 'P250',
    p90: 'P90',
    revolver: 'R8 Revolver',
    sawedoff: 'Sawed-Off',
    scar20: 'SCAR-20',
    sg556: 'SG 553',
    smokegrenade: 'Smoke Grenade',
    ssg08: 'SSG 08',
    taser: 'Zeus x27',
    tec9: 'Tec-9',
    ump45: 'UMP-45',
    usp_silencer: 'USP-S',
    xm1014: 'XM1014',
  };
  return names[normalized] ?? value(weapon);
}

function formalRoundEvents(
  events: readonly MatchEvent[],
  mapNumber: number,
): readonly FormalRoundEvent[] {
  interface RoundCandidate {
    readonly events: readonly MatchEvent[];
    readonly roundNumber: number;
  }

  const candidates = new Map<number, RoundCandidate>();
  let startedRound: number | null = null;
  let bufferedEvents: MatchEvent[] = [];
  const score = (event: MatchEvent, key: 'ct_score' | 't_score'): number | null => {
    const raw = eventAttribute(event, key);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  };

  for (const event of events) {
    if (event.mapNumber !== mapNumber) continue;
    if (event.type === '1') {
      startedRound =
        event.roundNumber !== null &&
        Number.isInteger(event.roundNumber) &&
        event.roundNumber > 0
          ? event.roundNumber
          : null;
      bufferedEvents = [];
      continue;
    }
    if (event.type === '6' || event.type === '8') {
      bufferedEvents.push(event);
      continue;
    }
    if (event.type !== '2') continue;

    const ctScore = score(event, 'ct_score');
    const tScore = score(event, 't_score');
    const completedRounds = ctScore === null || tScore === null ? null : ctScore + tScore;
    if (completedRounds !== null && completedRounds > 0) {
      candidates.set(completedRounds, {
        events: [...bufferedEvents, event],
        roundNumber: completedRounds,
      });
    }
    startedRound = null;
    bufferedEvents = [];
  }

  const ordered = [...candidates.values()].sort((a, b) => a.roundNumber - b.roundNumber);
  const contiguous: RoundCandidate[] = [];
  for (const candidate of ordered) {
    const previous = contiguous.at(-1);
    if (previous !== undefined && candidate.roundNumber !== previous.roundNumber + 1) break;
    contiguous.push(candidate);
  }
  const finalCompletedRound = contiguous.at(-1)?.roundNumber ?? null;
  if (
    startedRound !== null &&
    bufferedEvents.length > 0 &&
    (finalCompletedRound === null || startedRound === finalCompletedRound + 1)
  ) {
    contiguous.push({ events: bufferedEvents, roundNumber: startedRound });
  }
  return contiguous.flatMap((candidate) =>
    candidate.events.map((event) => ({ event, roundNumber: candidate.roundNumber })));
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
  if (trueEventAttribute(event, 'killer_blind')) details.push('击杀者处于致盲状态');
  const assister = eventAttribute(event, 'assist_assister_name')
    ?? eventAttribute(event, 'assist_assister_nick');
  if (assister !== null) {
    const side = eventSide(eventAttribute(event, 'assist_assister_side'));
    details.push(`助攻：${canonicalPlayerName(context, assister)}${side === null ? '' : ` (${side})`}`);
  }
  const flasher = eventAttribute(event, 'flasher_nick');
  if (flasher !== null && flasher !== assister) {
    const side = eventSide(eventAttribute(event, 'flasher_side'));
    details.push(`闪光助攻：${canonicalPlayerName(context, flasher)}${side === null ? '' : ` (${side})`}`);
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
  const suffix = [weaponName(eventAttribute(event, 'weapon')), ...details].join('；');
  return `${killer}[${value(eventSide(eventAttribute(event, 'killer_side')))}] > ${victim}[${value(eventSide(eventAttribute(event, 'victim_side')))}]（${suffix}）`;
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
    winner === null ? null : `${value(eventSide(winner))} 获胜`,
    ctScore === null || tScore === null ? null : `阵营比分 CT ${ctScore}:${tScore} T`,
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
  const lines: string[] = [
    `- 采集状态：${sectionStatus(section)}`,
    '- 范围：仅正式回合中的击杀、下包和回合结束事件；按发生顺序排列',
    '- 日志比分为随换边变化的 CT:T 阵营比分；逐回合结果中的比分为固定战队顺序',
    '',
  ];
  const trusted = section.status === 'complete' || section.status === 'empty';
  if (!trusted) {
    lines.push('- 为避免不完整日志误导分析，本节不输出事件明细；完整原始响应仍保留在同目录 JSON 中', '');
  }
  if (trusted && section.data !== null) {
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
        '- `>` 表示击杀；括号内依次为标准武器/伤害类型及关键信息',
        '',
        ...table(
          ['回合', '正式事件'],
          formalEventRows(context, events),
        ),
        '',
      );
    }
  }
  if (!trusted || section.data === null || !lines.some((line) => line.startsWith('#### '))) {
    lines.push('_暂无正式回合日志_');
  }
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
  const teamNames = new Map(input.teams.map((team) => [team.id, team.name.trim()]));
  const playerNames = new Map<string, string>();
  for (const statistics of [
    input.seriesPlayerStatistics,
    ...input.maps.map((map) => map.playerStatistics),
  ]) {
    for (const team of statistics.teams) {
      for (const plane of [team.overall, team.ct, team.t]) {
        for (const player of plane.rows ?? []) playerNames.set(player.id, player.name.trim());
      }
    }
  }
  const aliases = new Map<string, string | null>();
  for (const name of playerNames.values()) {
    const key = normalizedPlayerAlias(name);
    const existing = aliases.get(key);
    aliases.set(key, existing === undefined || existing === name ? name : null);
  }
  const playerAliases = new Map(
    [...aliases].flatMap(([key, name]) => name === null ? [] : [[key, name] as const]),
  );
  return { input, playerAliases, playerNames, teamNames };
}

/** Renders a filtered, analysis-facing Markdown view while leaving the JSON source untouched. */
export function renderMatchMarkdown(input: MarkdownInput): string {
  const context = createContext(input);
  return `${MARKDOWN_HANDLERS.flatMap((handler) => handler(context)).join('\n').trim()}\n`;
}
