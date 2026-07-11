import type { HltvMatch, MatchDiagnostics, ScoreEntry } from '../types.js';
import { table } from './markdown_helpers.js';

export function renderChineseReport(match: HltvMatch, diagnostics: MatchDiagnostics): string {
  const teamName = (id: number | null): string => match.teams.find((team) => team.id === id)?.name ?? `team:${id ?? 'unknown'}`;
  const scoreText = (scores: ScoreEntry[]): string => scores.length ? scores.map((item) => `${teamName(item.teamId)} ${item.score}`).join(' — ') : '-';
  const lines: string[] = [
    `# ${match.teams.map((team) => team.name).join(' vs. ')} — HLTV 采集质量报告`, '',
    '## 概览', '',
    `- Consumer schema：${match.schemaVersion}`,
    `- 比赛 ID：${match.match.id}`,
    `- Slug：${match.match.slug}`,
    `- 状态：${match.match.status}`,
    `- 赛事：${match.match.event.name}`,
    `- 赛制：${match.match.format}；${match.match.stage}`,
    `- 生成时间：${match.generatedAt}`,
    `- Consumer JSON：${diagnostics.consumerAudit.compactBytes} bytes（紧凑格式）`, '',
    '## 数据职责分离', '',
    '- `match.json`：稳定、去重的业务数据。',
    '- `match.md`：覆盖全部业务区块的英文报告。',
    '- `diagnostics.json`：抓取、过滤、对账、告警和验证证据。',
    '- `artifacts/`：本次调用产生的原始页面、HTML 和 Scorebot 快照。', '',
    '## 地图与一致性', '',
    ...table(['地图', '状态', '最终/当前比分', '完成回合', '比分一致', 'Scoreboard'], match.maps.map((map) => {
      const check = diagnostics.mapChecks[map.name]!;
      return [map.name, map.status, scoreText(map.score), check.completedRounds, check.consistent ? '通过' : '失败', map.scoreboard ? '已收录且比分匹配' : map.status === 'current' ? '见 current' : '未收录'];
    })), '',
    '## 区块完整性', '',
    `- 队伍：${match.teams.length}`,
    `- 选手：${match.players.length}`,
    `- 阵容：${match.lineups.length}`,
    `- 直播流：${match.streams.length}`,
    `- Veto 条目：${match.veto.length}`,
    `- 地图：${match.maps.length}`,
    `- Map stats 指标：${Object.keys(match.mapStats.metrics).length}`,
    `- 近期比赛视图：${match.recentMatches.views.length}`,
    `- H2H 比赛：${match.headToHead.matches.length}`,
    `- 正式回合：${match.maps.flatMap((map) => map.gameLog.rounds).length}`, '',
    '## 对账告警', '',
  ];
  if (!diagnostics.warnings.length) lines.push('- 无。', '');
  else lines.push(...diagnostics.warnings.map((warning) => `- ${warning.code}：${warning.reason ?? warning.section ?? warning.map ?? '请查看 diagnostics.json。'}`), '');
  lines.push(
    '## 验证结果', '',
    `- Consumer 禁止字段命中：${diagnostics.consumerAudit.forbiddenKeyHits.length}。`,
    `- 敏感信息命中：${diagnostics.consumerAudit.sensitiveValueHits.length}。`,
    `- 已结束地图比分/回合一致：${diagnostics.consumerAudit.allCompletedMapScoresConsistent ? '通过' : '失败'}。`,
    '- Game log 只在 `maps[].gameLog.rounds[].events` 保存一次；回合开始为隐式边界，回合结束由 `result` 表示。', '',
  );
  return `${lines.join('\n')}\n`;
}
