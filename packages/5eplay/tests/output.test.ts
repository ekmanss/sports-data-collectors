import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  describeMatchState,
  renderMatchMarkdown,
  writeMatchSnapshotArtifacts,
} from '../src/index.js';
import { createFiveEPlayMatchSourceWithTransport } from '../src/api/source.js';
import type { MatchSnapshot, MatchState } from '../src/domain/model.js';
import { ReplayTransport } from '../src/transport/replay.js';

const MATCH_ID = 'csgo_mc_2395547';

async function snapshotFromFixture(file: string): Promise<MatchSnapshot> {
  const payload = JSON.parse(
    await readFile(new URL(`./fixtures/states/${file}`, import.meta.url), 'utf8'),
  ) as unknown;
  const frame = {
    kind: 'ok' as const,
    payload,
    status: 200,
    urlIncludes: `/matches/${MATCH_ID}/data`,
  };
  const result = await createFiveEPlayMatchSourceWithTransport(
    {},
    new ReplayTransport([frame, frame]),
  ).snapshot(MATCH_ID);
  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') throw new Error('fixture snapshot was not confirmed');
  return result.snapshot;
}

async function snapshotWithAnalysis(): Promise<MatchSnapshot> {
  const matchId = 'csgo_mc_2395918';
  const [
    corePayload,
    analysisPayload,
    recentFirst,
    recentSecond,
    pastFirst,
    pastSecond,
  ] = await Promise.all([
    readFile(
      new URL('./fixtures/states/bo3-detail-map1-unopened.json', import.meta.url),
      'utf8',
    ).then((body) => JSON.parse(body) as unknown),
    readFile(new URL('./fixtures/analysis/full.json', import.meta.url), 'utf8')
      .then((body) => JSON.parse(body) as unknown),
    readFile(new URL('./fixtures/team-history/header-recent.json', import.meta.url), 'utf8')
      .then((body) => JSON.parse(body) as unknown),
    readFile(
      new URL('./fixtures/team-history/header-recent-team2.json', import.meta.url),
      'utf8',
    ).then((body) => JSON.parse(body) as unknown),
    readFile(new URL('./fixtures/team-history/analysis-recent.json', import.meta.url), 'utf8')
      .then((body) => JSON.parse(body) as unknown),
    readFile(
      new URL('./fixtures/team-history/analysis-recent-team2.json', import.meta.url),
      'utf8',
    ).then((body) => JSON.parse(body) as unknown),
  ]);
  const coreFrame = {
    kind: 'ok' as const,
    payload: corePayload,
    status: 200,
    urlIncludes: `/matches/${matchId}/data`,
  };
  const result = await createFiveEPlayMatchSourceWithTransport(
    {},
    new ReplayTransport([
      coreFrame,
      {
        kind: 'ok',
        payload: analysisPayload,
        status: 200,
        urlIncludes: `/matches/${matchId}/analysis_v1`,
      },
      {
        kind: 'ok',
        payload: recentFirst,
        status: 200,
        urlIncludes: '/teams/hltv_team_13892/matches',
      },
      {
        kind: 'ok',
        payload: recentSecond,
        status: 200,
        urlIncludes: '/teams/hltv_team_13528/matches',
      },
      {
        kind: 'ok',
        payload: pastFirst,
        status: 200,
        urlIncludes: '/team/matches_v1/hltv_team_13892',
      },
      {
        kind: 'ok',
        payload: pastSecond,
        status: 200,
        urlIncludes: '/team/matches_v1/hltv_team_13528',
      },
      coreFrame,
    ]),
  ).snapshot(matchId);
  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') throw new Error('analysis fixture was not confirmed');
  return result.snapshot;
}

async function snapshotWithDetailedStatistics(): Promise<MatchSnapshot> {
  const [core, fragment] = await Promise.all([
    readFile(
      new URL('./fixtures/states/bo3-complete-three-maps.json', import.meta.url),
      'utf8',
    ).then((body) => JSON.parse(body)),
    readFile(
      new URL('./fixtures/statistics/normal-terminal.json', import.meta.url),
      'utf8',
    ).then((body) => JSON.parse(body)),
  ]) as [
    {
      data: {
        match: {
          bouts_state: Array<Record<string, unknown>>;
          global_state: Record<string, unknown>;
        };
      };
    },
    {
      globalState: Record<string, unknown>;
      maps: Array<Record<string, unknown> & { bout_num: string }>;
    },
  ];
  Object.assign(core.data.match.global_state, fragment.globalState);
  for (const mapStatistics of fragment.maps) {
    const target = core.data.match.bouts_state.find(
      (map) => map.bout_num === mapStatistics.bout_num,
    );
    assert.ok(target);
    Object.assign(target, mapStatistics);
  }
  const frame = {
    kind: 'ok' as const,
    payload: core,
    status: 200,
    urlIncludes: `/matches/${MATCH_ID}/data`,
  };
  const result = await createFiveEPlayMatchSourceWithTransport(
    { timing: { closeCalibrationMs: 1, livePollMs: 1 } },
    new ReplayTransport([frame, frame]),
  ).snapshot(MATCH_ID);
  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') throw new Error('statistics fixture was not confirmed');
  return result.snapshot;
}

async function snapshotWithEvents(): Promise<MatchSnapshot> {
  type FixtureEventRow = {
    bout_id: string;
    bout_num: string;
    log_info: string;
    map_name: string;
    match_id: string;
    tt_id: string;
    update_version: string;
  };
  type FixtureEventPayload = { data: { list: FixtureEventRow[] } };
  const [corePayload, eventPayload] = await Promise.all([
    readFile(
      new URL('./fixtures/states/bo3-between-map2-map3.json', import.meta.url),
      'utf8',
    ).then((body) => JSON.parse(body) as unknown),
    readFile(new URL('./fixtures/events/page-1.json', import.meta.url), 'utf8')
      .then((body) => JSON.parse(body) as FixtureEventPayload),
  ]);
  const template = eventPayload.data.list[0];
  assert.ok(template);
  const eventRow = (
    updateVersion: string,
    type: string,
    detailKey: string,
    detail: Record<string, unknown>,
    mapNumber = 1,
    mapName = 'Anubis',
  ): FixtureEventRow => ({
    ...template,
    bout_id: `${MATCH_ID}_${mapNumber}`,
    bout_num: String(mapNumber),
    log_info: JSON.stringify({ [detailKey]: detail, type }),
    map_name: mapName,
    update_version: updateVersion,
  });
  const killRow = (
    updateVersion: string,
    weapon: string,
    killerName: string,
    victimName: string,
    mapNumber = 1,
    mapName = 'Anubis',
  ): FixtureEventRow => eventRow(
    updateVersion,
    '8',
    'kill',
    {
      head_shot: true,
      killer_id: mapNumber === 1 ? '999001' : '999011',
      killer_name: killerName,
      killer_side: 'T',
      victim_id: mapNumber === 1 ? '999002' : '999012',
      victim_name: victimName,
      victim_side: 'CT',
      weapon,
    },
    mapNumber,
    mapName,
  );
  eventPayload.data.list.push(
    killRow('1784543700000', 'warmup_only', 'WarmupKiller', 'WarmupVictim'),
    eventRow('1784543710000', '1', 'round_start', { round_num: '1' }),
    eventRow('1784543711000', '3', 'player_join', {
      player_id: '999003',
      player_name: 'HiddenJoin',
    }),
    eventRow('1784543720000', '6', 'bomb_planted', {
      bomb_site: 'B',
      ct_players: '3',
      player_name: 'Planter',
      t_players: '2',
    }),
    eventRow('1784543740000', '2', 'round_end', {
      ct_score: '0',
      t_score: '1',
      win_type: 'Target_Bombed',
      win_type_app: 3,
      winner: 'T',
    }),
    killRow('1784543741000', 'post_round_only', 'LateKiller', 'LateVictim'),
    eventRow('1784543750000', '1', 'round_start', { round_num: '1' }, 2, 'Cache'),
    killRow('1784543751000', 'ak47', 'Map2Killer', 'Map2Victim', 2, 'Cache'),
    eventRow('1784543752000', '2', 'round_end', {
      ct_score: '0',
      t_score: '1',
      win_type: 'Terrorists_Win',
      win_type_app: 2,
      winner: 'T',
    }, 2, 'Cache'),
  );
  const coreFrame = {
    kind: 'ok' as const,
    payload: corePayload,
    status: 200,
    urlIncludes: `/matches/${MATCH_ID}/data`,
  };
  const result = await createFiveEPlayMatchSourceWithTransport(
    {},
    new ReplayTransport([
      coreFrame,
      {
        kind: 'ok',
        payload: eventPayload,
        status: 200,
        urlIncludes: `/match/${MATCH_ID}/event/log`,
      },
      coreFrame,
    ]),
  ).snapshot(MATCH_ID, { eventLimits: { maxPages: 1 } });
  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') throw new Error('event fixture was not confirmed');
  return result.snapshot;
}

test('analysis-facing status describes every supported BO3 stage', () => {
  const cases: readonly [MatchState, string][] = [
    [
      {
        certainty: 'confirmed',
        closure: null,
        dataFinality: 'provisional',
        lifecycle: 'scheduled',
        phase: { kind: 'prestart' },
      },
      '比赛未开始',
    ],
    [
      {
        certainty: 'confirmed',
        closure: null,
        dataFinality: 'provisional',
        lifecycle: 'live',
        phase: { kind: 'map-unopened', mapNumber: 1 },
      },
      '比赛已开始，图 1 未开始',
    ],
    [
      {
        certainty: 'confirmed',
        closure: null,
        dataFinality: 'provisional',
        lifecycle: 'live',
        phase: { kind: 'map-live', mapNumber: 1 },
      },
      '图 1 进行中',
    ],
    [
      {
        certainty: 'confirmed',
        closure: null,
        dataFinality: 'provisional',
        lifecycle: 'live',
        phase: { kind: 'between-maps', previousMapNumber: 1, nextMapNumber: 2 },
      },
      '图 1 已结束，图 2 未开始',
    ],
    [
      {
        certainty: 'confirmed',
        closure: null,
        dataFinality: 'provisional',
        lifecycle: 'live',
        phase: { kind: 'map-live', mapNumber: 2 },
      },
      '图 2 进行中',
    ],
    [
      {
        certainty: 'confirmed',
        closure: null,
        dataFinality: 'provisional',
        lifecycle: 'live',
        phase: { kind: 'between-maps', previousMapNumber: 2, nextMapNumber: 3 },
      },
      '图 2 已结束，图 3 未开始',
    ],
    [
      {
        certainty: 'confirmed',
        closure: null,
        dataFinality: 'provisional',
        lifecycle: 'live',
        phase: { kind: 'map-live', mapNumber: 3 },
      },
      '图 3 进行中',
    ],
    [
      {
        certainty: 'confirmed',
        closure: 'normal',
        dataFinality: 'provisional',
        lifecycle: 'closing',
        phase: { kind: 'series-ended', finalMapNumber: 2 },
      },
      '比赛已结束，最后进行图 2（结果待稳定确认）',
    ],
    [
      {
        certainty: 'confirmed',
        closure: 'normal',
        dataFinality: 'stable',
        lifecycle: 'closed',
        phase: { kind: 'series-ended', finalMapNumber: 3 },
      },
      '比赛已结束，最后进行图 3（结果已稳定）',
    ],
  ];

  for (const [state, expected] of cases) {
    assert.equal(describeMatchState(state), expected);
  }
});

test('Markdown keeps analysis data and omits transport and artwork fields', async () => {
  const snapshot = await snapshotFromFixture('bo3-between-map2-map3.json');
  const markdown = renderMatchMarkdown(snapshot);

  assert.match(markdown, /\*\*图 2 已结束，图 3 未开始\*\*/);
  assert.match(markdown, /系列赛比分：ARCRED 1:1 1win/);
  assert.match(markdown, /## 对阵信息/);
  assert.match(markdown, /V社排名/);
  assert.match(markdown, /## 地图BP/);
  assert.match(markdown, /## 比赛数据/);
  assert.match(markdown, /### 第一局 \/ Anubis/);
  assert.match(markdown, /### 第二局 \/ Cache/);
  assert.match(markdown, /### 第三局 \/ Mirage/);
  assert.match(markdown, /### 数据总览/);
  assert.doesNotMatch(markdown, /schema/i);
  assert.doesNotMatch(markdown, /revision/i);
  assert.doesNotMatch(markdown, /logoUrl/i);
  assert.doesNotMatch(markdown, /iconUrl/i);
  assert.doesNotMatch(markdown, /country/i);
  assert.doesNotMatch(markdown, /https?:\/\//i);
});

test('Markdown keeps player details for settled and live maps only', async () => {
  const betweenMaps = renderMatchMarkdown(
    await snapshotFromFixture('bo3-between-map2-map3.json'),
  );
  const firstMap = betweenMaps.slice(
    betweenMaps.indexOf('### 第一局 / Anubis'),
    betweenMaps.indexOf('### 第二局 / Cache'),
  );
  const secondMap = betweenMaps.slice(
    betweenMaps.indexOf('### 第二局 / Cache'),
    betweenMaps.indexOf('### 第三局 / Mirage'),
  );
  const thirdMap = betweenMaps.slice(
    betweenMaps.indexOf('### 第三局 / Mirage'),
    betweenMaps.indexOf('### 数据总览'),
  );
  assert.match(firstMap, /#### 选手数据/);
  assert.match(firstMap, /\| Ryujin \|/);
  assert.match(secondMap, /#### 选手数据/);
  assert.match(secondMap, /\| lattykk \|/);
  assert.doesNotMatch(thirdMap, /#### 选手数据/);

  const liveMap = renderMatchMarkdown(await snapshotFromFixture('bo3-map1-live.json'));
  const liveFirstMap = liveMap.slice(
    liveMap.indexOf('### 第一局 / Anubis'),
    liveMap.indexOf('### 第二局'),
  );
  assert.match(liveFirstMap, /状态：进行中/);
  assert.match(liveFirstMap, /#### 选手数据/);
  assert.match(liveFirstMap, /\*\*选手状态快照\*\*/);
  assert.match(liveFirstMap, /\| 选手 \| Rating \| K-D-A \| K\/D \| KD差 \| KAST \| ADR \| Swing \| KPR \| DPR \| 爆头率 \| 首杀次数 \|/);
});

test('Markdown retains API-only statistical detail useful for analysis', async () => {
  const markdown = renderMatchMarkdown(await snapshotWithDetailedStatistics());

  assert.match(markdown, /\*\*CT\*\*/);
  assert.match(markdown, /\*\*T\*\*/);
  assert.match(markdown, /\*\*高级指标\*\*/);
  assert.match(markdown, /Opening Kill%/);
  assert.match(markdown, /Flash Assists/);
  assert.match(markdown, /Traded Deaths/);
  assert.match(markdown, /\*\*对位数据\*\*/);
  assert.match(markdown, /\*\*Multi-kill 分布\*\*/);
  assert.match(markdown, /\*\*选手对比\*\*/);
  assert.match(markdown, /\*\*MVP 指标参考\*\*/);
  assert.match(markdown, /#### 逐回合结果/);
  assert.match(markdown, /\| 回合 \| 阶段 \| 胜方 \| 阵营 \| 获胜方式 \| 回合后比分 \|/);
  assert.match(markdown, /\| R1 \| 上半场 \| [^|]+ \| T \| 歼灭敌人 \|/);
  assert.match(markdown, /\| R2 \| 上半场 \| [^|]+ \| CT \| 拆弹获胜 \|/);
  assert.match(markdown, /\| R4 \| 上半场 \| [^|]+ \| T \| 炸弹爆炸 \|/);
  assert.match(markdown, /\| R6 \| 上半场 \| [^|]+ \| CT \| 超时获胜 \|/);
  assert.match(markdown, /\| R13 \| 下半场 \| [^|]+ \| T \| 歼灭敌人 \|/);
  assert.doesNotMatch(markdown, /上半场回合序列|下半场回合序列/);
  assert.match(markdown, /Quick Score/);
});

test('Markdown groups useful formal-round logs by map and omits non-round noise', async () => {
  const markdown = renderMatchMarkdown(await snapshotWithEvents());

  assert.match(markdown, /### 比赛日志/);
  assert.match(markdown, /#### 第一局 \/ Anubis/);
  assert.match(markdown, /#### 第二局 \/ Cache/);
  assert.match(markdown, /\| 回合 \| 事件 \| 发起方 \| 阵营 \| 目标 \| 目标阵营 \| 武器 \/ 炸弹点 \| 关键信息 \|/);
  assert.match(markdown, /\| R1 \| 击杀 \| reyoz \| T \| shg \| CT \| galilar \| 助攻：Qikert \(T\) \|/);
  assert.match(markdown, /\| R1 \| 放置炸弹 \| Planter \| T \| — \| — \| B \| 存活：CT 3 \/ T 2 \|/);
  assert.match(markdown, /\| R1 \| 回合结束 \| T \| T \| — \| — \| — \| T 获胜；比分 CT 0:1 T；炸弹爆炸 \|/);
  assert.match(markdown, /\| R1 \| 击杀 \| Map2Killer \| T \| Map2Victim \| CT \| ak47 \| 爆头 \|/);
  assert.doesNotMatch(markdown, /事件属性|weapon=|killer_side=|HiddenJoin|warmup_only|post_round_only/);
  assert.doesNotMatch(markdown, /weapon_logo|https?:\/\//i);
});

test('Markdown follows 5E terminology and pre-match analysis hierarchy', async () => {
  const markdown = renderMatchMarkdown(await snapshotWithAnalysis());

  assert.match(markdown, /## 赛前分析/);
  assert.match(markdown, /### 选手分析（近三个月数据）/);
  assert.match(markdown, /### 选手能力指标/);
  assert.match(markdown, /### 地图分析（近三个月数据）/);
  assert.match(markdown, /### 战队分析（近三个月数据）/);
  assert.match(markdown, /### 近期战绩/);
  assert.match(markdown, /### 交手战绩（最近五场）/);
  assert.doesNotMatch(markdown, /补充战队历史数据/);
  assert.doesNotMatch(markdown, /按赛事分组的近期记录/);
  assert.doesNotMatch(markdown, /历史比赛统计/);
  assert.match(markdown, /\| 战队 \| 选手 \| Rating \| K\/D \| KAST \| SWING \| ADR \| KPR \|/);
  assert.match(markdown, /\| ex-MANA \| BledarD \| 1\.1 \| 1\.1 \| 69\.9% \| \+0\.5% \| 76\.7 \| 0\.73 \|/);
  assert.match(markdown, /\| Mirage \| pick \| ex-MANA \|/);
  assert.doesNotMatch(markdown, /荒漠迷城|沙漠2|炼狱小镇/);
  assert.match(markdown, /上半场手枪局胜率/);
  assert.match(markdown, /下半场手枪局胜率/);
  assert.doesNotMatch(markdown, /虚拟排名/);
  assert.doesNotMatch(markdown, /首选阵营率|次选阵营率/);
  assert.doesNotMatch(markdown, /选手评分|社区评分/);
});

test('artifact writer preserves the complete JSON beside the filtered Markdown', async (context) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'fiveeplay-output-'));
  context.after(async () => rm(outputDirectory, { force: true, recursive: true }));
  const snapshot = await snapshotFromFixture('bo3-map1-live.json');

  const paths = await writeMatchSnapshotArtifacts(snapshot, {
    basename: 'match-observation',
    outputDirectory,
  });

  assert.equal(paths.jsonPath, join(outputDirectory, 'match-observation.json'));
  assert.equal(paths.markdownPath, join(outputDirectory, 'match-observation.md'));
  assert.deepEqual(JSON.parse(await readFile(paths.jsonPath, 'utf8')), snapshot);
  assert.equal(await readFile(paths.markdownPath, 'utf8'), renderMatchMarkdown(snapshot));
  await assert.rejects(
    writeMatchSnapshotArtifacts(snapshot, {
      basename: 'match-observation',
      outputDirectory,
    }),
    /EEXIST/,
  );
  assert.deepEqual(JSON.parse(await readFile(paths.jsonPath, 'utf8')), snapshot);
});
