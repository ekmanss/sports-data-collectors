import type {
  FiveEPlayLogEvent,
  FiveEPlayMap,
  FiveEPlayMatch,
  FiveEPlayPlayerStats,
  FiveEPlayTeamPlayerStats,
  GetFiveEPlayMatchResult,
} from './types.js';
import { integer, record, records, text } from './value.js';

export interface FiveEPlayMarkdownOptions {
  includeDiagnostics?: boolean;
}

function plain(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value).replace(/[\r\n]+/g, ' ').trim() || '—';
}

function cell(value: unknown): string {
  return plain(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function html(value: unknown): string {
  return plain(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function table(headers: string[], rows: unknown[][]): string {
  return [
    `| ${headers.map(cell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

function percent(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

function number(value: number | null): string {
  return value === null ? '—' : String(value);
}

function yesNo(value: boolean | null): string {
  return value === null ? '—' : value ? '是' : '否';
}

function timestamp(value: number | null): string {
  if (value === null) return '—';
  const date = new Date(value * 1_000);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString();
}

function compactTimestamp(value: number | null): string {
  if (value === null) return '—';
  const date = new Date(value * 1_000);
  return Number.isNaN(date.valueOf())
    ? String(value)
    : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function status(value: FiveEPlayMatch['match']['status'] | FiveEPlayMap['status']): string {
  if (value === 'live') return '进行中';
  if (value === 'completed') return '已完成';
  if (value === 'upcoming') return '未开始';
  return '未知';
}

function teamName(match: FiveEPlayMatch, teamId: string | null): string {
  if (!teamId) return '—';
  return match.teams.find((team) => team.id === teamId)?.name ?? teamId;
}

function teamScore(match: FiveEPlayMatch, teamId: string): number | null {
  return match.match.seriesScore.find((entry) => entry.teamId === teamId)?.score ?? null;
}

function halfScore(map: FiveEPlayMap, index: number, half: 'firstHalf' | 'secondHalf' | 'overtime'): string {
  const value = map.teams[index]?.[half];
  if (!value) return '—';
  if (value.side === null && value.score === null) return '—';
  return `${number(value.score)}（${value.side ?? '阵营未知'}）`;
}

function roundSequence(
  map: FiveEPlayMap,
  index: number,
  half: 'firstHalf' | 'secondHalf' | 'overtime',
): string {
  const rounds = map.teams[index]?.[half].roundResults ?? [];
  return rounds.length ? rounds.map((result) => result === 0 ? '负' : '胜').join(' · ') : '—';
}

function playerRows(
  match: FiveEPlayMatch,
  groups: Array<{ teamId: string; players: FiveEPlayPlayerStats[] }>,
  includeEquipment: boolean,
): unknown[][] {
  return groups.flatMap((group) => group.players.map((player) => {
    const metrics = player.metrics;
    const base: unknown[] = [
      teamName(match, group.teamId), player.name,
      `${number(metrics.kills)}-${number(metrics.deaths)}-${number(metrics.assists)}`,
      number(metrics.rating), number(metrics.kdRatio), number(metrics.kdDifference),
      percent(metrics.kastRate), number(metrics.adr), percent(metrics.roundSwingRate),
      number(metrics.killsPerRound), number(metrics.deathsPerRound),
      percent(metrics.headshotRate), number(metrics.firstKills), number(metrics.firstDeaths),
      number(metrics.flashAssists), number(metrics.tradedDeaths), number(metrics.clutchWins),
    ];
    if (includeEquipment) {
      base.push(
        number(player.equipment.health), number(player.equipment.money),
        player.equipment.weapon, yesNo(player.equipment.armor), yesNo(player.equipment.helmet),
        yesNo(player.equipment.defuseKit), yesNo(player.equipment.alive),
      );
    }
    return base;
  }));
}

function playerTable(
  match: FiveEPlayMatch,
  groups: Array<{ teamId: string; players: FiveEPlayPlayerStats[] }>,
  includeEquipment = false,
): string {
  const headers = [
    '战队', '选手', 'K-D-A', 'Rating', 'K/D', 'KD差', 'KAST', 'ADR', 'Swing',
    'KPR', 'DPR', '爆头率', '首杀', '首死', '闪光助攻', '被补枪', '残局胜利',
  ];
  if (includeEquipment) {
    headers.push('生命', '金钱', '武器', '护甲', '头盔', '拆弹器', '存活');
  }
  const rows = playerRows(match, groups, includeEquipment);
  return rows.length ? table(headers, rows) : '_暂无选手数据_';
}

function splitPlayerDetails(match: FiveEPlayMatch, stats: FiveEPlayTeamPlayerStats[]): string[] {
  const ct = stats.map((group) => ({ teamId: group.teamId, players: group.ct }));
  const terrorists = stats.map((group) => ({ teamId: group.teamId, players: group.t }));
  if (![...ct, ...terrorists].some((group) => group.players.length)) return [];
  return [
    '<details>',
    '<summary>CT / T 分侧数据</summary>',
    '',
    '#### CT 数据',
    '',
    playerTable(match, ct),
    '',
    '#### T 数据',
    '',
    playerTable(match, terrorists),
    '',
    '</details>',
  ];
}

function duelMatrix(match: FiveEPlayMatch, map: FiveEPlayMap): string {
  const left = map.playerStats[0]?.overall ?? [];
  const right = map.playerStats[1]?.overall ?? [];
  if (!left.length || !right.length) return '_暂无选手对比数据_';
  const kills = new Map(map.playerDuels.map((duel) => [
    `${duel.playerId}:${duel.opponentPlayerId}`,
    duel.kills,
  ]));
  const rows = left.map((player) => [
    player.name,
    ...right.map((opponent) => {
      const forward = kills.get(`${player.id}:${opponent.id}`) ?? 0;
      const reverse = kills.get(`${opponent.id}:${player.id}`) ?? 0;
      return `${forward}:${reverse}`;
    }),
  ]);
  const leftName = teamName(match, map.playerStats[0]?.teamId ?? null);
  const rightName = teamName(match, map.playerStats[1]?.teamId ?? null);
  return [
    `_${leftName}（行）击杀数 : ${rightName}（列）击杀数_`,
    '',
    table(['选手', ...right.map((player) => player.name)], rows),
  ].join('\n');
}

function logPlayer(player: { name: string; side: string | null }): string {
  return `${plain(player.name)}${player.side ? ` [${player.side}]` : ''}`;
}

function logDescription(event: FiveEPlayLogEvent): string {
  if (event.kill) {
    const kill = event.kill;
    const flags = [
      kill.headshot ? '爆头' : null,
      kill.wallbang ? '穿墙' : null,
      kill.throughSmoke ? '穿烟' : null,
      kill.noScope ? '盲狙' : null,
      kill.killerBlind ? '击杀者致盲' : null,
    ].filter((value): value is string => value !== null);
    const extras = [
      kill.assister ? `助攻 ${logPlayer(kill.assister)}` : null,
      kill.flasher ? `闪光 ${logPlayer(kill.flasher)}` : null,
      flags.length ? flags.join('、') : null,
    ].filter((value): value is string => value !== null);
    return `${logPlayer(kill.killer)} → ${logPlayer(kill.victim)}（${plain(kill.weapon)}${extras.length ? `；${extras.join('；')}` : ''}）`;
  }
  if (event.roundStart) {
    return `第 ${number(event.roundStart.round)} 回合开始`;
  }
  if (event.roundEnd) {
    const end = event.roundEnd;
    return `回合结束：CT ${number(end.ctScore)} : ${number(end.tScore)} T；胜者 ${plain(end.winnerSide)}；原因 ${plain(end.reason)}（${number(end.reasonCode)}）`;
  }
  if (event.bombPlanted) {
    const bomb = event.bombPlanted;
    return `${logPlayer(bomb.player)} 在 ${plain(bomb.site)} 区下包；存活 CT ${number(bomb.ctPlayers)} / T ${number(bomb.tPlayers)}`;
  }
  if (event.bombDefused) return `${logPlayer(event.bombDefused)} 完成拆包`;
  if (event.suicide) return `${logPlayer(event.suicide.player)} 使用 ${plain(event.suicide.weapon)} 自杀`;
  if (event.playerJoined) return `${logPlayer(event.playerJoined)} 加入比赛`;
  if (event.playerLeft) return `${logPlayer(event.playerLeft)} 离开比赛`;
  if (event.kind === 'match-started') return '比赛开始';
  if (event.kind === 'restart') return `比赛重启：${JSON.stringify(event.restart)}`;
  return `未知事件（类型 ${number(event.type)}）`;
}

function eventLog(map: FiveEPlayMap): string[] {
  if (!map.eventLog.events.length) return ['_暂无比赛日志_'];
  let round: number | null = null;
  const rows = map.eventLog.events.map((event, index) => {
    if (event.roundStart?.round !== null && event.roundStart?.round !== undefined) {
      round = event.roundStart.round;
    }
    return [index + 1, round, event.kind, logDescription(event)];
  });
  return [
    '<details>',
    `<summary>比赛日志回顾（${map.eventLog.events.length} 条；${map.eventLog.complete ? '完整' : '持续更新中'}）</summary>`,
    '',
    table(['#', '回合', '类型', '内容'], rows),
    '',
    '</details>',
  ];
}

function highlightsAndMilestones(match: FiveEPlayMatch, map: FiveEPlayMap): string[] {
  if (!map.highlights.length && !map.milestones.length) return [];
  const players = new Map(map.playerStats.flatMap((team) => team.overall.map((player) => [
    player.id,
    player.name,
  ] as const)));
  const highlightRows = map.highlights.map((value) => {
    const highlight = record(value);
    const metrics = records(highlight.data);
    const player1Id = text(highlight.t1_player_id);
    const player2Id = text(highlight.t2_player_id);
    const player1Data = metrics.map((metric) =>
      `${text(metric.title) ?? '指标'} ${text(metric.t1_data) ?? '—'}`).join('；');
    const player2Data = metrics.map((metric) =>
      `${text(metric.title) ?? '指标'} ${text(metric.t2_data) ?? '—'}`).join('；');
    return [
      text(highlight.title),
      player1Id ? players.get(player1Id) ?? player1Id : null,
      player1Data || null,
      player2Id ? players.get(player2Id) ?? player2Id : null,
      player2Data || null,
    ];
  });
  const milestoneRows = map.milestones.map((value) => {
    const milestone = record(value);
    return [
      text(milestone.player_name), text(milestone.honor_text), text(milestone.detail),
      text(milestone.achieve_time),
    ];
  });
  const lines = ['### 高光与里程碑', ''];
  if (highlightRows.length) {
    lines.push(
      '#### 高光表现', '',
      table([
        '项目',
        `${match.teams[0]?.name ?? '队伍1'}选手`,
        '关键数据',
        `${match.teams[1]?.name ?? '队伍2'}选手`,
        '关键数据',
      ], highlightRows),
      '',
    );
  }
  if (milestoneRows.length) {
    lines.push(
      '#### 里程碑', '',
      table(['选手', '荣誉', '说明', '达成日期'], milestoneRows),
      '',
    );
  }
  return lines;
}

function jsonDetails(summary: string, value: unknown): string[] {
  return [
    '<details>',
    `<summary>${html(summary)}</summary>`,
    '',
    '```json',
    JSON.stringify(value, null, 2),
    '```',
    '',
    '</details>',
  ];
}

function mapSection(match: FiveEPlayMatch, map: FiveEPlayMap): string[] {
  if (map.status === 'upcoming') {
    return [
      `## 地图 ${map.number} · ${plain(map.name)} · ${status(map.status)}`,
      '',
      '> 本地图尚未开始，暂无比分和比赛数据。',
      '',
    ];
  }
  const first = match.teams[0];
  const second = match.teams[1];
  const score = map.teams.map((team) => number(team.score)).join(' : ');
  const rows: unknown[][] = [
    ['状态', status(map.status)],
    ['比分', `${first?.name ?? '队伍1'} ${score} ${second?.name ?? '队伍2'}`],
    ['选择方', map.pickAction === 'left' ? '决胜图' : teamName(match, map.pickedByTeamId)],
    ['胜者', teamName(match, map.resultTeamId)],
    ['当前回合', map.currentRound],
    ['回合阶段', map.roundStage],
    ['回合计时（秒）', map.gameTimeSeconds],
    ['炸弹已安放', map.bombPlanted ? '是' : '否'],
    ['开始时间', timestamp(map.startedAtUnixSeconds)],
    ['结束时间', timestamp(map.endedAtUnixSeconds)],
  ];
  const halfScores = map.teams.map((team, index) => [
    teamName(match, team.teamId), team.score, team.currentSide,
    halfScore(map, index, 'firstHalf'), halfScore(map, index, 'secondHalf'),
    halfScore(map, index, 'overtime'),
  ]);
  const roundSequences = map.teams.map((team, index) => [
    teamName(match, team.teamId),
    roundSequence(map, index, 'firstHalf'), roundSequence(map, index, 'secondHalf'),
    roundSequence(map, index, 'overtime'),
  ]);
  const lines = [
    `## 地图 ${map.number} · ${plain(map.name)} · ${status(map.status)}`,
    '',
    table(['项目', '内容'], rows),
    '',
    '### 半场与回合',
    '',
    '#### 比分拆分',
    '',
    table(['战队', '总比分', '当前阵营', '上半场比分（阵营）', '下半场比分（阵营）', '加时比分（阵营）'], halfScores),
    '',
    '#### 逐回合胜负',
    '',
    '> “胜”表示该战队赢下该回合，“负”表示该战队输掉该回合；顺序从左到右。',
    '',
    table(['战队', '上半场', '下半场', '加时'], roundSequences),
    '',
  ];
  if (map.status === 'live') {
    lines.push('### 实时计分板', '', playerTable(match, map.playerStats.map((group) => ({
      teamId: group.teamId, players: group.overall,
    })), true), '');
  } else if (map.playerStats.some((group) => group.overall.length)) {
    lines.push('### 数据总览', '', playerTable(match, map.playerStats.map((group) => ({
      teamId: group.teamId, players: group.overall,
    }))), '', ...splitPlayerDetails(match, map.playerStats), '');
  }
  if (map.playerDuels.length) {
    lines.push('### 选手对比', '', duelMatrix(match, map), '');
  }
  lines.push(...highlightsAndMilestones(match, map));
  lines.push('### 比赛日志', '', ...eventLog(map), '');
  return lines;
}

function recentMatchesSection(match: FiveEPlayMatch): string[] {
  const analysis = match.analysis;
  if (!analysis) return [];
  const lines = ['### 近期比赛', ''];
  for (const item of analysis.recentMatches) {
    const rows = item.matches.flatMap((group) => records(record(group).matches)).map((game) => {
      const home = record(game.home_info);
      const opponent = record(game.opponent_info);
      const teamIsHome = text(home.id) === item.teamId || text(opponent.id) !== item.teamId;
      const teamScore = integer(game[teamIsHome ? 'home_score' : 'opponent_score']);
      const opponentScore = integer(game[teamIsHome ? 'opponent_score' : 'home_score']);
      const opponentName = text((teamIsHome ? opponent : home).disp_name);
      const outcome = teamScore === null || opponentScore === null ? '—'
        : teamScore > opponentScore ? '胜' : teamScore < opponentScore ? '负' : '平';
      return [
        compactTimestamp(integer(game.ts)),
        opponentName,
        `${number(teamScore)} : ${number(opponentScore)}`,
        outcome,
      ];
    });
    lines.push(
      `#### ${plain(teamName(match, item.teamId))}`,
      '',
      rows.length
        ? table(['比赛时间', '对手', '比分（本队 : 对手）', '结果'], rows)
        : '_暂无近期比赛数据_',
      '',
    );
  }
  return lines;
}

const POWER_COLUMNS = [
  ['fire_power_value', '火力'],
  ['entrying_value', '突破'],
  ['opening_value', '首杀'],
  ['utility_value', '道具'],
  ['sniping_value', '狙击'],
  ['clutching_value', '残局'],
  ['trading_value', '补枪'],
] as const;

function playerPowerSection(match: FiveEPlayMatch): string[] {
  const analysis = match.analysis;
  if (!analysis) return [];
  const rows = analysis.playerPower.flatMap((team) => team.players.map((value) => {
    const player = record(value);
    const identity = record(player.player_item);
    const scores = new Map(records(player.player_power_data_items).flatMap((item) => {
      const key = text(item.label_key);
      return key ? [[key, text(item.score)]] : [];
    }));
    return [
      teamName(match, team.teamId),
      text(identity.player_name),
      text(identity.hltv_rating),
      ...POWER_COLUMNS.map(([key]) => scores.get(key) ?? null),
    ];
  }));
  return [
    '### 选手能力', '',
    '> 能力项为源站 0–100 评分；数值越高，代表该项近期表现越突出。', '',
    rows.length
      ? table(['战队', '选手', 'Rating', ...POWER_COLUMNS.map(([, label]) => label)], rows)
      : '_暂无选手能力数据_',
    '',
  ];
}

function analysisSection(match: FiveEPlayMatch): string[] {
  const analysis = match.analysis;
  if (!analysis) return ['## 赛前分析', '', '_本次采集没有赛前分析数据_', ''];
  const teamRows = analysis.teams.map((team) => [
    teamName(match, team.teamId), percent(team.winRate), number(team.rating),
    number(team.kdRatio), percent(team.firstHalfPistolWinRate),
    percent(team.secondHalfPistolWinRate),
  ]);
  const playerRows = analysis.teams.flatMap((team) => team.players.map((player) => [
    teamName(match, team.teamId), player.name, player.country, number(player.rating),
    number(player.kdRatio), percent(player.kastRate), number(player.adr),
    number(player.killsPerRound), number(player.impact), number(player.multiKillRating),
    percent(player.roundSwingRate),
  ]));
  const mapRows = analysis.maps.flatMap((map) => map.teams.map((team) => [
    map.name, map.localizedName, map.bpType, teamName(match, team.teamId),
    team.matches, team.wins, percent(team.winRate), team.picks, percent(team.pickRate),
    team.bans, percent(team.banRate),
  ]));
  const headToHead = analysis.headToHead.matches.map((value) => {
    const historicalMatch = record(record(value).match);
    return [
      compactTimestamp(integer(historicalMatch.ts)),
      integer(historicalMatch.t1_score),
      integer(historicalMatch.t2_score),
    ];
  });
  const lines = [
    '## 赛前分析', '',
    '### 战队对比', '',
    table(['战队', '胜率', 'Rating', 'K/D', '上半场手枪胜率', '下半场手枪胜率'], teamRows), '',
    '### 选手分析', '',
    playerRows.length ? table(
      ['战队', '选手', '国家', 'Rating', 'K/D', 'KAST', 'ADR', 'KPR', 'Impact', '多杀Rating', 'Swing'],
      playerRows,
    ) : '_暂无选手分析_', '',
    '### 地图分析', '',
    mapRows.length ? table(
      ['地图', '本地名', 'BP类型', '战队', '场次', '胜场', '胜率', '选择', '选择率', '禁用', '禁用率'],
      mapRows,
    ) : '_暂无地图分析_', '',
    '### 历史交手', '',
    headToHead.length
      ? table(['比赛时间', match.teams[0]?.name ?? '队伍1', match.teams[1]?.name ?? '队伍2'], headToHead)
      : '_暂无历史交手数据_',
    '',
    ...recentMatchesSection(match),
    ...playerPowerSection(match),
  ];
  return lines;
}

function diagnosticsSection(result: GetFiveEPlayMatchResult): string[] {
  const diagnostics = result.diagnostics;
  return [
    '## 采集诊断', '',
    table(['项目', '内容'], [
      ['Schema', diagnostics.schemaVersion],
      ['开始时间', diagnostics.startedAt],
      ['完成时间', diagnostics.completedAt],
      ['耗时', `${diagnostics.durationMs} ms`],
      ['请求数', diagnostics.requests.length],
      ['警告数', diagnostics.warnings.length],
    ]), '',
    '<details>',
    '<summary>HTTP 请求明细</summary>', '',
    table(
      ['类型', 'HTTP', '耗时(ms)', '字节', '地图', '页签'],
      diagnostics.requests.map((request) => [
        request.kind, request.status, request.durationMs, request.bytes,
        request.mapNumber, request.tab,
      ]),
    ), '',
    '</details>', '',
    ...jsonDetails(`采集警告（${diagnostics.warnings.length}）`, diagnostics.warnings), '',
  ];
}

export function renderFiveEPlayMatchMarkdown(
  result: GetFiveEPlayMatchResult,
  options: FiveEPlayMarkdownOptions = {},
): string {
  const match = result.data;
  const first = match.teams[0];
  const second = match.teams[1];
  const title = `${first?.name ?? '队伍1'} ${number(first ? teamScore(match, first.id) : null)} : ${number(second ? teamScore(match, second.id) : null)} ${second?.name ?? '队伍2'}`;
  const overviewRows: unknown[][] = [
    ['比赛状态', status(match.match.status)],
    ['比赛ID', match.match.id],
    ['比赛版本', match.match.version],
    ['赛制', match.match.bestOf === null ? null : `BO${match.match.bestOf}`],
    ['采集时间', match.capturedAt],
    ['源页面', match.source.url],
  ];
  const teamRows = match.teams.map((team) => [
    team.name, team.id, team.country, team.seriesScore, team.rank, team.valveRank,
  ]);
  const vetoRows = match.veto.map((entry) => [
    entry.order,
    entry.action === 'ban' ? '禁用' : entry.action === 'pick' ? '选择' : entry.action === 'left' ? '决胜图' : '未知',
    teamName(match, entry.teamId), entry.map,
  ]);
  const lines = [
    `# ${plain(title)}`, '',
    '## 比赛概览', '',
    table(['项目', '内容'], overviewRows), '',
    '### 战队', '',
    table(['战队', 'ID', '国家', '大比分', '5E排名', 'Valve排名'], teamRows), '',
    '### 地图 BP', '',
    vetoRows.length ? table(['顺序', '操作', '战队', '地图'], vetoRows) : '_暂无 BP 数据_', '',
  ];
  for (const map of match.maps) {
    lines.push(...mapSection(match, map));
  }
  lines.push(...analysisSection(match));
  if (options.includeDiagnostics !== false) lines.push(...diagnosticsSection(result));
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
