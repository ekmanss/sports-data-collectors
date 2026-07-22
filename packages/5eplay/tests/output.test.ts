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

async function snapshotWithUnusedDecider(): Promise<MatchSnapshot> {
  const matchId = 'csgo_mc_2396047';
  const payload = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-complete-two-maps.json', import.meta.url),
      'utf8',
    ),
  ) as {
    data: {
      match: {
        bouts_state: Array<{
          curr_bout_stage: string;
          status: string;
          t1_stats: { id: string };
          t2_stats: { id: string };
        }>;
        mc_info: { t1_info: { id: string }; t2_info: { id: string } };
      };
    };
  };
  const unusedMap = payload.data.match.bouts_state[2];
  assert.ok(unusedMap);
  unusedMap.status = '2';
  unusedMap.curr_bout_stage = 'fh';
  unusedMap.t1_stats.id = payload.data.match.mc_info.t1_info.id;
  unusedMap.t2_stats.id = payload.data.match.mc_info.t2_info.id;
  const frame = {
    kind: 'ok' as const,
    payload,
    status: 200,
    urlIncludes: `/matches/${matchId}/data`,
  };
  const result = await createFiveEPlayMatchSourceWithTransport(
    { timing: { closeCalibrationMs: 1, livePollMs: 1 } },
    new ReplayTransport([frame, frame]),
  ).snapshot(matchId);
  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') throw new Error('fixture snapshot was not confirmed');
  return result.snapshot;
}

async function snapshotWithAnalysis(
  mutateAnalysis?: (payload: unknown) => void,
): Promise<MatchSnapshot> {
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
  mutateAnalysis?.(analysisPayload);
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
    eventId?: string,
  ): FixtureEventRow => eventRow(
    updateVersion,
    '8',
    'kill',
    {
      head_shot: true,
      killer_id: mapNumber === 1 ? '999001' : '999011',
      killer_name: killerName,
      killer_side: 'T',
      ...(eventId === undefined ? {} : { event_id: eventId }),
      victim_id: mapNumber === 1 ? '999002' : '999012',
      victim_name: victimName,
      victim_side: 'CT',
      weapon,
    },
    mapNumber,
    mapName,
  );
  const assistedKill = killRow(
    '1784543803900',
    'galilar',
    'reyoz',
    'shg',
    1,
    'Anubis',
    'formal-assist',
  );
  const assistedKillInfo = JSON.parse(assistedKill.log_info) as Record<string, unknown>;
  const assistedKillDetail = assistedKillInfo.kill as Record<string, unknown>;
  assistedKillDetail.head_shot = false;
  assistedKillInfo.assist = {
    assister_name: 'Qikert',
    assister_side: 'T',
  };
  assistedKill.log_info = JSON.stringify(assistedKillInfo);
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
    eventRow('1784543800000', '1', 'round_start', { round_num: '1' }),
    killRow('1784543801000', 'knife_karambit', 'WarmupKiller', 'WarmupVictim'),
    eventRow('1784543802000', '2', 'round_end', {
      ct_score: '0',
      t_score: '1',
      win_type: 'Terrorists_Win',
      win_type_app: 2,
      winner: 'T',
    }),
    eventRow('1784543803000', '1', 'round_start', { round_num: '2' }),
    assistedKill,
    killRow('1784543804000', 'm4a1', 'reyoz', 'shg', 1, 'Anubis', 'formal-1'),
    killRow('1784543804001', 'm4a1', 'reyoz', 'shg', 1, 'Anubis', 'formal-1'),
    eventRow('1784543804500', '6', 'bomb_planted', {
      bomb_site: 'B',
      ct_players: '3',
      player_name: 'Planter',
      t_players: '2',
    }),
    eventRow('1784543805000', '2', 'round_end', {
      ct_score: '0',
      t_score: '1',
      win_type: 'Target_Bombed',
      win_type_app: 3,
      winner: 'T',
    }),
    eventRow('1784543806000', '1', 'round_start', { round_num: '2' }),
    eventRow('1784543807000', '2', 'round_end', {
      ct_score: '1',
      t_score: '1',
      win_type: 'CTs_Win',
      win_type_app: 7,
      winner: 'CT',
    }),
    killRow('1784543808000', 'deagle', 'reyoz', 'shg', 1, 'Anubis', 'formal-3'),
    eventRow('1784543809000', '2', 'round_end', {
      ct_score: '1',
      t_score: '2',
      win_type: 'Terrorists_Win',
      win_type_app: 2,
      winner: 'T',
    }),
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
      {
        kind: 'ok',
        payload: eventPayload,
        status: 200,
        urlIncludes: `/match/${MATCH_ID}/event/log`,
      },
      coreFrame,
    ]),
  ).snapshot(MATCH_ID);
  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') throw new Error('event fixture was not confirmed');
  const snapshot = structuredClone(result.snapshot);
  (snapshot.maps[0] as { currentRound: number }).currentRound = 3;
  (snapshot.maps[1] as { currentRound: number }).currentRound = 1;
  return snapshot;
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
      '比赛已结束，共进行 2 张地图（结果待稳定确认）',
    ],
    [
      {
        certainty: 'confirmed',
        closure: 'normal',
        dataFinality: 'stable',
        lifecycle: 'closed',
        phase: { kind: 'series-ended', finalMapNumber: 3 },
      },
      '比赛已结束，共进行 3 张地图（结果已稳定）',
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
  assert.match(firstMap, /\|Ryujin\|/);
  assert.match(secondMap, /#### 选手数据/);
  assert.match(secondMap, /\|lattykk\|/);
  assert.doesNotMatch(thirdMap, /#### 选手数据/);

  const liveMap = renderMatchMarkdown(await snapshotFromFixture('bo3-map1-live.json'));
  const liveFirstMap = liveMap.slice(
    liveMap.indexOf('### 第一局 / Anubis'),
    liveMap.indexOf('### 第二局'),
  );
  assert.match(liveFirstMap, /状态：进行中/);
  assert.match(liveFirstMap, /#### 选手数据/);
  assert.match(liveFirstMap, /\*\*选手状态快照\*\*/);
  assert.match(liveFirstMap, /\|选手\|K-D-A\|KD差\|ADR\|/);
  assert.match(liveFirstMap, /即时比分（接口遥测）/);
  assert.doesNotMatch(liveFirstMap, /全表无数据字段/);
});

test('Markdown renders settled, live, and unused maps with state-specific fields', async () => {
  const markdown = renderMatchMarkdown(await snapshotWithUnusedDecider());
  const firstMap = markdown.slice(
    markdown.indexOf('### 第一局'),
    markdown.indexOf('### 第二局'),
  );
  const unusedMap = markdown.slice(
    markdown.indexOf('### 第三局'),
    markdown.indexOf('### 数据总览'),
  );

  assert.match(firstMap, /最终比分/);
  assert.doesNotMatch(firstMap, /即时比分|当前阵营|回合计时|Flags/);
  assert.match(unusedMap, /未进行（决胜图；系列赛提前结束）/);
  assert.match(unusedMap, /decider（剩余决胜图）/);
  assert.doesNotMatch(unusedMap, /\|战队\||unused|技术判定/);
});

test('Markdown retains API-only statistical detail useful for analysis', async () => {
  const markdown = renderMatchMarkdown(await snapshotWithDetailedStatistics());

  assert.match(markdown, /\*\*CT\*\*/);
  assert.match(markdown, /\*\*T\*\*/);
  assert.match(markdown, /\*\*高级指标\*\*/);
  assert.match(markdown, /Opening Kill%（回合占比）/);
  assert.match(markdown, /Flash Assists（次数）/);
  assert.match(markdown, /Traded Deaths/);
  assert.match(markdown, /\*\*对位数据\*\*/);
  assert.match(markdown, /单元格：击杀\/首杀；`\*` 表示接口最高标记/);
  assert.match(markdown, /\|DSSj\|6\/2\|5\/2\|7\/2\|10\/3\|7\/1\|/);
  assert.match(markdown, /\|shg\|5\/3\|5\/2\|11\*\/1\|6\/1\|6\/1\|/);
  assert.match(markdown, /\*\*Multi-kill 分布\*\*/);
  assert.match(markdown, /\*\*选手对比\*\*/);
  assert.match(markdown, /代表选手由整个对比项确定/);
  assert.doesNotMatch(markdown, /\*\*MVP 指标参考\*\*/);
  assert.match(markdown, /#### 逐回合结果/);
  assert.match(markdown, /\|回合\|阶段\|胜方\|胜方当回合阵营\|获胜方式\|比分（ARCRED:1win）\|/);
  assert.match(markdown, /\|R1\|上半场\|[^|]+\|T\|歼灭敌人\|/);
  assert.match(markdown, /\|R2\|上半场\|[^|]+\|CT\|拆弹获胜\|/);
  assert.match(markdown, /\|R4\|上半场\|[^|]+\|T\|炸弹爆炸\|/);
  assert.match(markdown, /\|R6\|上半场\|[^|]+\|CT\|超时获胜\|/);
  assert.match(markdown, /\|R13\|下半场\|[^|]+\|T\|歼灭敌人\|/);
  assert.doesNotMatch(markdown, /上半场回合序列|下半场回合序列/);
  assert.doesNotMatch(markdown, /Quick Score|Flags|Damage\/Round/);
});

test('Markdown groups useful formal-round logs by map and omits non-round noise', async () => {
  const markdown = renderMatchMarkdown(await snapshotWithEvents());

  assert.match(markdown, /### 比赛日志/);
  assert.match(markdown, /#### 第一局 \/ Anubis/);
  assert.match(markdown, /#### 第二局 \/ Cache/);
  assert.match(markdown, /\|回合\|正式事件\|/);
  assert.match(markdown, /reyoz\[T\] > shg\[CT\]（Galil AR；助攻：Qikert \(T\)）/);
  assert.match(markdown, /Planter\[T\] 放置炸弹@B（存活 CT 3\/T 2）/);
  assert.match(markdown, /回合结束：T 获胜；阵营比分 CT 0:1 T；炸弹爆炸/);
  assert.match(markdown, /Map2Killer\[T\] > Map2Victim\[CT\]（AK-47；爆头）/);
  assert.match(markdown, /R3.*reyoz\[T\] > shg\[CT\]（Desert Eagle；爆头）/s);
  assert.equal(markdown.match(/reyoz\[T\] > shg\[CT\]（M4A4；爆头）/g)?.length, 1);
  assert.doesNotMatch(markdown, /事件属性|weapon=|killer_side=|HiddenJoin|warmup_only|post_round_only|WarmupKiller/);
  assert.doesNotMatch(markdown, /weapon_logo|https?:\/\//i);
});

test('Markdown trims a long warmup prefix when the provider omits the first formal round start', async () => {
  const snapshot = structuredClone(await snapshotWithEvents());
  const events = snapshot.details.events.data;
  assert.ok(events);
  const killTemplate = events.find((event) => event.type === '8' && event.mapNumber === 1);
  const endTemplate = events.find((event) => event.type === '2' && event.mapNumber === 1);
  assert.ok(killTemplate);
  assert.ok(endTemplate);

  const kill = (
    updateVersion: string,
    killer: string,
    victim: string,
    eventId: string,
  ) => {
    const event = structuredClone(killTemplate);
    (event as { updateVersion: string }).updateVersion = updateVersion;
    const attributes = event.attributes as Record<string, string | number | boolean | null>;
    attributes.killer_name = killer;
    attributes.killer_nick = killer;
    attributes.victim_name = victim;
    attributes.victim_nick = victim;
    attributes.event_id = eventId;
    return event;
  };
  const warmup = Array.from({ length: 20 }, (_, index) =>
    kill(
      String(1_784_543_700_000 + index * 1_000),
      'WarmupKiller',
      `WarmupVictim${index % 2}`,
      `warmup-${index}`,
    ),
  );
  const formal = Array.from({ length: 4 }, (_, index) =>
    kill(
      String(1_784_543_820_000 + index * 1_000),
      `FormalKiller${index}`,
      `FormalVictim${index}`,
      `formal-${index}`,
    ),
  );
  const roundEnd = structuredClone(endTemplate);
  (roundEnd as { updateVersion: string }).updateVersion = '1784543825000';
  const roundEndAttributes = roundEnd.attributes as Record<
    string,
    string | number | boolean | null
  >;
  roundEndAttributes.ct_score = '0';
  roundEndAttributes.t_score = '1';
  (snapshot.details.events as { data: typeof events }).data = [
    ...warmup,
    ...formal,
    roundEnd,
    ...events.filter((event) => event.mapNumber === 2),
  ];
  (snapshot.maps[0] as { currentRound: number }).currentRound = 1;

  const markdown = renderMatchMarkdown(snapshot);

  assert.match(markdown, /FormalKiller0/);
  assert.doesNotMatch(markdown, /WarmupKiller|WarmupVictim/);
});

test('Markdown withholds a formally incomplete settled-map log even when transport is complete', async () => {
  const snapshot = structuredClone(await snapshotWithEvents());
  (snapshot.maps[0] as { currentRound: number }).currentRound = 5;

  const markdown = renderMatchMarkdown(snapshot);

  assert.match(markdown, /正式回合覆盖不完整/);
  assert.match(markdown, /为避免不完整日志误导分析，仅对应地图不输出事件明细/);
  assert.doesNotMatch(markdown, /#### 第一局 \/ Anubis/);
  assert.match(markdown, /#### 第二局 \/ Cache/);
});

test('Markdown withholds incomplete event logs and exposes the exact collection gap', async () => {
  const snapshot = structuredClone(await snapshotWithEvents());
  const section = snapshot.details.events as {
    gap: string | null;
    status: MatchSnapshot['details']['events']['status'];
  };
  section.status = 'partial';
  section.gap = 'PAGE_LIMIT';

  const markdown = renderMatchMarkdown(snapshot);

  assert.match(markdown, /采集状态：部分数据（缺口：`PAGE_LIMIT`）/);
  assert.match(markdown, /为避免不完整日志误导分析，本节不输出事件明细/);
  assert.doesNotMatch(markdown, /#### 第一局 \/ Anubis/);
});

test('Markdown suppresses placeholder telemetry, trims labels, and normalizes equipment', async () => {
  const snapshot = structuredClone(await snapshotFromFixture('bo3-map1-live.json'));
  (snapshot as { observedAt: number }).observedAt = 1_784_543_400_000;
  const firstMap = snapshot.maps[0] as {
    gameTimeSeconds: number | null;
    roundStartedAt: number | null;
    playerStatistics: MatchSnapshot['maps'][number]['playerStatistics'];
  };
  firstMap.gameTimeSeconds = 0;
  firstMap.roundStartedAt = 1_784_543_499_999;
  const player = firstMap.playerStatistics.teams[0].overall.rows?.[0] as {
    equipment: string[];
  } | undefined;
  assert.ok(player);
  player.equipment = [
    'm4a1',
    'deagle',
    'hegrenade',
    'knife_butterfly',
    'knife_m9_bayonet',
    'ssg08',
  ];
  const firstTeam = snapshot.teams[0] as { name: string };
  firstTeam.name = `  ${firstTeam.name}  `;

  const markdown = renderMatchMarkdown(snapshot);

  assert.doesNotMatch(markdown, /回合计时（秒）：0/);
  assert.doesNotMatch(markdown, /2026-07-18T07:51:39\.999Z/);
  assert.match(markdown, /接口时间晚于快照，已忽略/);
  assert.match(
    markdown,
    /M4A4, Desert Eagle, HE Grenade, Butterfly Knife, M9 Bayonet, SSG 08/,
  );
  assert.doesNotMatch(markdown, /^#\s{2,}|\s{2,}vs/m);
});

test('Markdown does not present unresolved BP values as literal null or unknown', async () => {
  const snapshot = structuredClone(await snapshotFromFixture('bo3-prestart.json'));
  for (const map of snapshot.maps) {
    const unresolved = map as { vetoAction: null; vetoTeamId: null };
    unresolved.vetoAction = null;
    unresolved.vetoTeamId = null;
  }
  const markdown = renderMatchMarkdown(snapshot);

  assert.doesNotMatch(markdown, /本场 BP：null|本场BP[^\n]*unknown/);
  assert.match(markdown, /本场 BP：—/);
});

test('Markdown follows 5E terminology and pre-match analysis hierarchy', async () => {
  const markdown = renderMatchMarkdown(await snapshotWithAnalysis());

  assert.match(markdown, /## 赛前分析/);
  assert.match(markdown, /### 选手分析（近三个月数据）/);
  assert.match(markdown, /### 选手能力指标/);
  assert.match(markdown, /\|BledarD\|ex-MANA\|The Suspect\|1\.06\|/);
  assert.match(markdown, /统计范围：近 3 个月；全阵营/);
  assert.match(markdown, /Rating（5E）.*HLTV Rating.*不可直接互换/);
  assert.match(markdown, /\|能力指标\|BledarD\|vAloN\|ammar\|/);
  assert.match(markdown, /\|火力\|80\|25\|/);
  assert.match(markdown, /\|↳每回合击杀\|0\.74\|0\.61\|/);
  assert.match(markdown, /\|↳获胜回合平均击杀\|1\.03\|0\.87\|/);
  assert.doesNotMatch(markdown, /获胜回合平均击杀（2）/);
  assert.doesNotMatch(markdown, /指标单元格：分数\/参考线\/宽度/);
  assert.match(markdown, /### 地图分析（近三个月数据）/);
  assert.match(markdown, /### 战队分析（近三个月数据）/);
  assert.match(markdown, /### 近期战绩/);
  assert.match(markdown, /### 交手战绩（最近五场）/);
  assert.doesNotMatch(markdown, /补充战队历史数据/);
  assert.doesNotMatch(markdown, /按赛事分组的近期记录/);
  assert.doesNotMatch(markdown, /历史比赛统计/);
  assert.match(markdown, /\|战队\|选手\|Rating（5E）\|K\/D\|KAST\|5E SWING\|ADR\|KPR\|/);
  assert.match(markdown, /\|ex-MANA\|BledarD\|1\.1\|1\.1\|69\.9%\|\+0\.5%\|76\.7\|0\.73\|/);
  assert.match(markdown, /\|地图\|本场BP\|ex-MANA\|Misa\|/);
  assert.match(markdown, /\|Mirage\|pick（ex-MANA）\|2\/100%\/1\/12%\/0\/—\|13\/38%\/2\/6%\/8\/24%\|/);
  assert.doesNotMatch(markdown, /荒漠迷城|沙漠2|炼狱小镇/);
  assert.match(markdown, /上半场手枪局胜率/);
  assert.match(markdown, /下半场手枪局胜率/);
  assert.doesNotMatch(markdown, /虚拟排名/);
  assert.doesNotMatch(markdown, /首选阵营率|次选阵营率/);
  assert.doesNotMatch(markdown, /选手评分|社区评分/);
  assert.doesNotMatch(markdown, /\|Impact\||全表无数据字段/);
  assert.match(markdown, /接口未返回交手汇总或比赛明细/);
});

test('analysis power players are regrouped by the authoritative match roster', async () => {
  const snapshot = await snapshotWithAnalysis((payload) => {
    const analysis = payload as {
      data: {
        result: {
          power_comparison: {
            t1_player_stats: Array<{
              player_item: { team_id: string; team_name: string };
            }>;
            t2_player_stats: Array<{
              player_item: { team_id: string; team_name: string };
            }>;
          };
        };
      };
    };
    const power = analysis.data.result.power_comparison;
    const misplaced = power.t2_player_stats.shift();
    assert.ok(misplaced);
    misplaced.player_item.team_id = '';
    misplaced.player_item.team_name = '';
    power.t1_player_stats.push(misplaced);
  });

  assert.deepEqual(snapshot.details.analysis.data?.power.map((players) => players.length), [5, 5]);
  assert.equal(
    snapshot.details.analysis.data?.power[0]?.some((player) => player.playerName === 'Ckanic'),
    false,
  );
  assert.equal(
    snapshot.details.analysis.data?.power[1]?.some((player) => player.playerName === 'Ckanic'),
    true,
  );
});

test('Markdown treats provisional all-player-null KAST zeroes as missing values', async () => {
  const snapshot = structuredClone(await snapshotWithDetailedStatistics());
  const map = snapshot.maps[2];
  assert.ok(map);
  (snapshot as { state: MatchState }).state = {
    certainty: 'confirmed',
    closure: 'normal',
    dataFinality: 'provisional',
    lifecycle: 'closing',
    phase: { kind: 'series-ended', finalMapNumber: 3 },
  };
  for (const team of map.playerStatistics.teams) {
    for (const row of team.overall.rows ?? []) {
      (row as { kastPercent: number | null }).kastPercent = null;
    }
  }
  for (const team of snapshot.seriesPlayerStatistics.teams) {
    for (const row of team.overall.rows ?? []) {
      (row as { kastPercent: number | null }).kastPercent = null;
    }
  }
  const mapHighlights = map.playerStatistics.highlights.rows ?? [];
  const seriesHighlights = snapshot.seriesPlayerStatistics.highlights.rows ?? [];
  for (const row of [...mapHighlights, ...seriesHighlights]) {
    const metric = row.metrics.find((candidate) => candidate.title === 'KAST');
    if (metric) {
      (metric as unknown as { values: [string | null, string | null] }).values = ['0%', '0%'];
    }
  }

  const markdown = renderMatchMarkdown(snapshot);
  const mapSection = markdown.slice(
    markdown.indexOf(`### ${map.displayName}`),
    markdown.indexOf('### 数据总览'),
  );

  assert.doesNotMatch(mapSection, /KAST 0%/);
  assert.doesNotMatch(markdown.slice(markdown.indexOf('### 数据总览')), /KAST 0%/);
  assert.match(mapSection, /KAST —/);
});

test('Markdown omits overtime columns when a regulation map only has provider zero placeholders', async () => {
  const snapshot = structuredClone(await snapshotWithDetailedStatistics());
  const map = snapshot.maps[2];
  assert.ok(map);
  (map as { currentRound: number }).currentRound = 15;
  const [first, second] = map.teams;
  assert.ok(first);
  assert.ok(second);
  Object.assign(first, {
    firstHalfScore: 10,
    overtimeRounds: [],
    overtimeScore: 0,
    overtimeSide: 'CT',
    score: 13,
    secondHalfScore: 3,
  });
  Object.assign(second, {
    firstHalfScore: 2,
    overtimeRounds: [],
    overtimeScore: 0,
    overtimeSide: 'T',
    score: 2,
    secondHalfScore: 0,
  });

  const markdown = renderMatchMarkdown(snapshot);
  const mapSection = markdown.slice(
    markdown.indexOf(`### ${map.displayName}`),
    markdown.indexOf('### 数据总览'),
  );

  assert.doesNotMatch(mapSection, /加时/);
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
