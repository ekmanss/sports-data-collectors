import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getFiveEPlayMatch } from '../src/client.js';
import { matchIdentityFromInput } from '../src/input.js';
import {
  decodeMqttPackets,
  encodeConnectPacket,
  type DecodedMqttPacket,
} from '../src/mqtt.js';
import { createFiveEPlayMatchSession } from '../src/session.js';
import {
  buildFiveEPlayMatch,
  type CommunityCapture,
  type LogCapture,
} from '../src/transform.js';
import type {
  FiveEPlayWebSocketLike,
} from '../src/types.js';
import {
  fiveEPlayMarkdownOutputPath,
  writeFiveEPlayMatchMarkdown,
} from '../src/write_markdown.js';

const identity = {
  id: 'csgo_mc_2395709',
  numericId: 2395709,
  url: 'https://event.5eplay.com/csgo/matches/csgo_mc_2395709',
};

const team1 = {
  id: 'csgo_tm_1', disp_name: 'Alpha', logo: 'https://images/alpha.png', rank: '2',
  country: 'FR', v_rank: { rank: '3' },
};
const team2 = {
  id: 'csgo_tm_2', disp_name: 'Bravo', logo: 'https://images/bravo.png', rank: '4',
  country: 'BR', v_rank: { rank: '5' },
};

function sourcePlayer(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id, name, kill: '12', death: '8', assist: '4', kd_rate: '1.50', kd_diff: '+4',
    rating: '1.25', kast: '75.0%', adr: '88.4', kpr: '0.80', dpr: '0.53',
    impact: '1.10', mk_rating: '1.05', swing: '+3.2%', headshot: '6',
    head_shot_rate: '50%', first_blood_num: '3', first_death_num: '1',
    first_blood_rate: '18.8%', flash_assist: '2', traded_death: '1', cl_win_num: '1',
    round_mvp: '2', k2: '2', k3: '1', k4: '0', k5: '0',
    v1: '1', v2: '0', v3: '0', v4: '0', v5: '0', hp: '', money: '',
    kevlar: '', helmet: '', has_defusekit: '', weapon: '', weapon_logo: '',
    portrait: `https://images/${id}.png`, half_portrait: null, country_logo: null,
    counter_kill_map: {}, first_kill_map: {}, ...overrides,
  };
}

const detailData = {
  state_ver: '100',
  match: {
    global_state: {
      status: '1', t1_score: '1', t2_score: '0', t1_quick_score: '1', t2_quick_score: '0',
      t1_odds: '1.75', t2_odds: '2.10', t1_odds_percent: '55', t2_odds_percent: '45',
      bp_map_item: [
        { bp_type: 'ban', team_side: 't1', map_name: 'Mirage' },
        { bp_type: 'ban', team_side: 't2', map_name: 'Ancient' },
        { bp_type: 'pick', team_side: 't1', map_name: 'Cache', map_icon: 'cache.png' },
        { bp_type: 'pick', team_side: 't2', map_name: 'Inferno', map_icon: 'inferno.png' },
        { bp_type: 'ban', team_side: 't2', map_name: 'Anubis' },
        { bp_type: 'ban', team_side: 't1', map_name: 'Dust2' },
        { bp_type: 'left', team_side: '', map_name: 'Nuke', map_icon: 'nuke.png' },
      ],
    },
    mc_info: {
      id: identity.id, format: '3', match_version: 'cs2', plan_ts: '1784204100',
      tt_stage: 'Playoffs', tt_stage_desc: 'Lower bracket', t1_info: team1, t2_info: team2,
    },
    tt_info: {
      id: 'csgo_tt_1', disp_name: 'Example Cup', logo: 'event.png', status: 'live',
      grade: '3', grade_label: 'A', addr: 'Barcelona', bonus: '$100,000',
      start_time: '2026-07-15 00:00:00', end_time: '2026-07-18 23:59:59', color: '663dea',
    },
    bouts_state: [
      {
        bout_num: '1', disp_name: '第一局', map_name: 'Cache', status: '2', display: '1',
        bp_act: 't1_pick', result: 't1', curr_round_num: '23', curr_bout_stage: 'sh',
        start_time: '10', end_time: '20', map_icon: 'cache.png', map_bgm: 'cache-bg.png',
        t1_stats: {
          id: '', all_score: '13', quick_score: '13', role: 'CT',
          fh_role: 'T', fh_score: '7', fh_data: [3, 2], sh_role: 'CT', sh_score: '6', sh_data: [1, 1],
          ot_role: '', ot_score: '', ot_data: [], flags: ['r1'],
        },
        t2_stats: {
          id: team2.id, all_score: '10', quick_score: '10', role: 'T',
          fh_role: 'CT', fh_score: '5', fh_data: [0, 0], sh_role: 'T', sh_score: '5', sh_data: [0, 0],
          ot_role: '', ot_score: '', ot_data: [], flags: [],
        },
        t1_pr_stats: [sourcePlayer('csgo_pl_1', 'Alice', { counter_kill_map: { csgo_pl_2: 5 } })],
        t2_pr_stats: [sourcePlayer('csgo_pl_2', 'Bob', { counter_kill_map: { csgo_pl_1: 4 } })],
        t1_pr_stats_ct: [], t1_pr_stats_t: [], t2_pr_stats_ct: [], t2_pr_stats_t: [],
        pr_stats: [{
          title: '首杀王', t1_player_id: 'csgo_pl_1', t2_player_id: 'csgo_pl_2',
          data: [{ title: '首杀数', t1_data: '3', t2_data: '2' }],
        }],
        milestones: [{
          id: '1', player_name: 'Alice', honor_text: '强势带飞',
          detail: '单图Rating达到1.25', values: '1.25', achieve_time: '2026-07-16',
        }],
      },
      {
        bout_num: '2', disp_name: '第二局', map_name: 'Inferno', status: '1', display: '1',
        bp_act: 't2_pick', result: '', curr_round_num: '11', curr_bout_stage: 'fh',
        round_start_time: '30', bomb_planted: '1', bomb_planted_time: '31',
        map_icon: 'inferno.png', map_bgm: 'inferno-bg.png',
        t1_stats: {
          id: team1.id, all_score: '7', quick_score: '7', role: 'CT',
          fh_role: 'CT', fh_score: '7', fh_data: [1, 1], sh_role: '', sh_score: '', sh_data: [],
          ot_role: '', ot_score: '', ot_data: [], flags: [],
        },
        t2_stats: {
          id: team2.id, all_score: '4', quick_score: '4', role: 'T',
          fh_role: 'T', fh_score: '4', fh_data: [0, 0], sh_role: '', sh_score: '', sh_data: [],
          ot_role: '', ot_score: '', ot_data: [], flags: [],
        },
        t1_pr_stats: [sourcePlayer('csgo_pl_1', 'Alice', {
          hp: '100', money: '2950', kevlar: '1', helmet: '1', has_defusekit: '1', weapon: 'ak47',
        })],
        t2_pr_stats: [sourcePlayer('csgo_pl_2', 'Bob', { hp: '0', money: '300' })],
        t1_pr_stats_ct: [], t1_pr_stats_t: [], t2_pr_stats_ct: [], t2_pr_stats_t: [],
        pr_stats: [], milestones: [],
      },
    ],
  },
};

const analysisData = {
  result: {
    comparison: {
      t1_stats: { win_rate: '60', rating: '1.10', kd: '1.05', f_rate: '50', s_rate: '40' },
      t2_stats: { win_rate: '40', rating: '0.95', kd: '0.90', f_rate: '30', s_rate: '35' },
      t1_player_stats: [{ id: 'csgo_pl_1', name: 'Alice', Rating: '1.20', kd: '1.10' }],
      t2_player_stats: [{ id: 'csgo_pl_2', name: 'Bob', Rating: '1.00', kd: '0.95' }],
      team_map_stats: [{ name: 'Cache', t1_count: 2, t1_win_num: 1, t1_rate: '50', t2_count: 1 }],
    },
    power_comparison: {
      is_hide: '0',
      t1_player_stats: [{
        player_item: { player_id: 'csgo_pl_1', player_name: 'Alice', hltv_rating: '1.20' },
        player_power_data_items: [
          { label_key: 'fire_power_value', label_name: '火力', score: '80' },
          { label_key: 'opening_value', label_name: '首杀', score: '70' },
        ],
      }],
      t2_player_stats: [{
        player_item: { player_id: 'csgo_pl_2', player_name: 'Bob', hltv_rating: '1.00' },
        player_power_data_items: [
          { label_key: 'fire_power_value', label_name: '火力', score: '60' },
          { label_key: 'utility_value', label_name: '道具', score: '75' },
        ],
      }],
    },
    t1_rec_matches: { matches: [{ matches: [{
      id: 'recent-1', ts: '1784204100',
      home_info: { id: team1.id, disp_name: team1.disp_name },
      opponent_info: { id: 'csgo_tm_3', disp_name: 'Charlie' },
      home_score: '2', opponent_score: '1', result: 't1', status: 'past',
    }] }] },
    t2_rec_matches: { matches: [{ matches: [{
      id: 'recent-2', ts: '1784200500',
      home_info: { id: 'csgo_tm_4', disp_name: 'Delta' },
      opponent_info: { id: team2.id, disp_name: team2.disp_name },
      home_score: '13', opponent_score: '10', result: 't1', status: 'past',
    }] }] },
    rec_vs_matches: {
      t1_win_rate: '60', t2_win_rate: '40',
      matches: [{ match: { id: 'h2h-1', ts: '1784204100', t1_score: '2', t2_score: '1' } }],
    },
  },
};

const logRows = [
  {
    update_version: '2', match_id: identity.id, tt_id: 'csgo_tt_1', bout_id: `${identity.id}_1`,
    bout_num: '1', map_name: 'Cache',
    log_info: JSON.stringify({ type: '2', round_end: { ct_score: '13', t_score: '10', winner: 'CT', win_type: 'CTs_Win', win_type_app: 1 } }),
  },
  {
    update_version: '1', match_id: identity.id, tt_id: 'csgo_tt_1', bout_id: `${identity.id}_1`,
    bout_num: '1', map_name: 'Cache',
    log_info: JSON.stringify({ type: '8', kill: {
      killer_nick: 'Alice', killer_side: 'CT', killer_id: '1', victim_nick: 'Bob',
      victim_side: 'T', victim_id: '2', weapon: 'ak47', head_shot: true,
      through_smoke: true, event_id: 'event-1', killer_x: '10', killer_y: '20',
      victim_x: '30', victim_y: '40',
    }, assist: { assister_nick: 'Carol', assister_side: 'CT' } }),
  },
];

const logs = new Map<number, LogCapture>([
  [1, { complete: true, fromVersion: '0', toVersion: '2', rows: logRows }],
  [2, { complete: false, fromVersion: '0', toVersion: null, rows: [] }],
]);

const tabs = [
  { tab: 'match_player', id: team1.id, name: team1.disp_name, is_selected: true },
  { tab: 'match_player', id: team2.id, name: team2.disp_name, is_selected: false },
  { tab: 'big_event', id: '', name: '大事件', is_selected: false },
];
const community: CommunityCapture = {
  tabs,
  cardsByTab: new Map([
    [`match_player:${team1.id}`, [{
      tab: 'match_player', card_content_tab: 'player', id: 'csgo_pl_1', name: 'Alice',
      positions: ['Rifler'], content: [], score: { avg_score: '4.5', user_cnt: '2', score_text: 'Great', star_num_user_cnt: [0, 0, 0, 1, 1], star_num_user_pct: ['0%', '0%', '0%', '50%', '50%'] },
      star_text: ['1', '2', '3', '4', '5'],
    }]],
    [`match_player:${team2.id}`, []],
    ['big_event:', []],
  ]),
};

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, errcode: 0, message: '', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(requests: string[]): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/data')) return response(detailData);
    if (url.endsWith('/analysis_v1')) return response(analysisData);
    if (url.includes('/event/log')) {
      const map = url.includes('_1') ? 1 : 2;
      return response({ from_ver: '0', to_ver: map === 1 ? '2' : '', not_more: map === 1 ? '1' : '', list: map === 1 ? logRows : [] });
    }
    if (url.includes('match_score_tab')) return response(tabs);
    if (url.includes('match_score_list')) {
      const parsed = new URL(url);
      return response(community.cardsByTab.get(`${parsed.searchParams.get('tab')}:${parsed.searchParams.get('team_id')}`) ?? []);
    }
    if (url.includes('/api/restrict/matchscore')) {
      assert.equal(init?.method, 'POST');
      return response({ client_id: 'client', username: 'user', password: 'pass' });
    }
    return new Response('not found', { status: 404 });
  };
}

test('canonicalizes 5EPlay match ids and URLs', () => {
  assert.deepEqual(matchIdentityFromInput(`${identity.url}/?ref=test#live`), identity);
  assert.deepEqual(matchIdentityFromInput(identity.id), identity);
  assert.equal(matchIdentityFromInput('https://example.com/csgo/matches/csgo_mc_2395709'), null);
  assert.equal(matchIdentityFromInput('csgo_mc_bad'), null);
});

test('builds every visible match section and synthesizes a temporarily omitted decider', () => {
  const match = buildFiveEPlayMatch({
    identity, capturedAt: '2026-07-16T00:00:00.000Z', detailData, analysisData, logs, community,
  });
  assert.equal(match.match.status, 'live');
  assert.equal(match.match.bestOf, 3);
  assert.deepEqual(match.maps.map((map) => [map.number, map.name, map.status]), [
    [1, 'Cache', 'completed'], [2, 'Inferno', 'live'], [3, 'Nuke', 'upcoming'],
  ]);
  for (const map of match.maps) {
    assert.deepEqual(map.teams.map((team) => team.teamId), ['csgo_tm_1', 'csgo_tm_2']);
  }
  assert.equal(match.maps[0]!.eventLog.complete, true);
  assert.deepEqual(match.maps[0]!.eventLog.events.map((event) => event.updateVersion), ['1', '2']);
  assert.equal(match.maps[0]!.playerStats[0]!.overall[0]!.metrics.rating, 1.25);
  assert.deepEqual(match.maps[0]!.playerDuels[0], {
    playerId: 'csgo_pl_1', opponentPlayerId: 'csgo_pl_2', kills: 5,
  });
  assert.equal(match.current?.playerStats[0]!.overall[0]!.equipment.health, 100);
  assert.equal(match.current?.bombPlanted, true);
  assert.equal(match.analysis?.teams[0]?.players[0]?.rating, 1.2);
  assert.equal(match.analysis?.recentMatches[0]?.matches.length, 1);
  assert.equal(match.communityRatings?.tabs[0]?.cards[0]?.score.average, 4.5);
});

test('parses detailed combat log flags and participants', () => {
  const match = buildFiveEPlayMatch({
    identity, capturedAt: '2026-07-16T00:00:00.000Z', detailData, analysisData, logs, community,
  });
  const event = match.maps[0]!.eventLog.events[0]!;
  assert.equal(event.kind, 'kill');
  assert.equal(event.kill?.killer.name, 'Alice');
  assert.equal(event.kill?.assister?.name, 'Carol');
  assert.equal(event.kill?.headshot, true);
  assert.equal(event.kill?.throughSmoke, true);
  assert.deepEqual(event.kill?.victimPosition, { x: 30, y: 40 });
});

test('captures a full match without launching a browser', async () => {
  const requests: string[] = [];
  const result = await getFiveEPlayMatch(identity.url, { fetch: mockFetch(requests), timeoutMs: 2_000 });
  assert.equal(result.data.maps.length, 3);
  assert.equal(result.data.maps[0]!.eventLog.events.length, 2);
  assert.equal(result.data.communityRatings?.tabs.length, 3);
  assert.equal(result.diagnostics.requests.filter((entry) => entry.kind === 'log').length, 2);
  assert.equal(result.diagnostics.requests.filter((entry) => entry.kind === 'community-list').length, 3);
  assert.ok(requests.every((url) => !url.includes('/api/restrict/matchscore')));
});

test('writes a complete formatted Markdown report to a file or directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), '5eplay-markdown-'));
  try {
    const requests: string[] = [];
    const written = await writeFiveEPlayMatchMarkdown(identity.url, directory, {
      fetch: mockFetch(requests),
      timeoutMs: 2_000,
    });
    assert.equal(written.outputPath, join(directory, `${identity.id}.md`));
    assert.equal(
      fiveEPlayMarkdownOutputPath(join(directory, 'custom.md'), identity.id),
      join(directory, 'custom.md'),
    );
    const markdown = await readFile(written.outputPath, 'utf8');
    for (const expected of [
      '# Alpha 1 : 0 Bravo',
      '## 地图 3 · Nuke · 未开始',
      '> 本地图尚未开始，暂无比分和比赛数据。',
      '#### 比分拆分',
      '#### 逐回合胜负',
      '“胜”表示该战队赢下该回合',
      '### 数据总览',
      '### 实时计分板',
      '### 选手对比',
      '#### 高光表现',
      '| 首杀王 | Alice | 首杀数 3 | Bob | 首杀数 2 |',
      '#### 里程碑',
      '| Alice | 强势带飞 | 单图Rating达到1.25 | 2026-07-16 |',
      '比赛日志回顾（2 条；完整）',
      '爆头',
      '## 赛前分析',
      '### 历史交手',
      '| 比赛时间 | Alpha | Bravo |',
      '| 2026-07-16 12:15 UTC | 2 | 1 |',
      '### 近期比赛',
      '| 2026-07-16 12:15 UTC | Charlie | 2 : 1 | 胜 |',
      '| 2026-07-16 11:15 UTC | Delta | 10 : 13 | 负 |',
      '### 选手能力',
      '| 战队 | 选手 | Rating | 火力 | 突破 | 首杀 | 道具 | 狙击 | 残局 | 补枪 |',
      '| Alpha | Alice | 1.20 | 80 | — | 70 | — | — | — | — |',
      '## 采集诊断',
    ]) assert.ok(markdown.includes(expected), `missing Markdown section: ${expected}`);
    assert.ok(!markdown.includes('## 社区评分'));
    assert.ok(!markdown.includes('<summary>历史交手'));
    assert.ok(!markdown.includes('<summary>Alpha 近期比赛'));
    assert.ok(!markdown.includes('<summary>Alpha 选手能力数据'));
    assert.ok(!markdown.includes('player_power_data_items'));
    assert.ok(!markdown.includes('<summary>高光数据'));
    assert.ok(!markdown.includes('<summary>里程碑'));
    assert.ok(!markdown.includes('| # | 回合 | 类型 | 版本 | 内容 |'));
    assert.ok(!markdown.includes('击杀者坐标'));
    assert.ok(!markdown.includes('被击杀者坐标'));
    assert.ok(!markdown.includes('源站回合方式码与节点标记'));
    assert.ok(requests.every((url) => !url.includes('/api/score/')));
    assert.equal(written.bytes, Buffer.byteLength(markdown));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function mqttPublish(topic: string, payload: unknown): Uint8Array {
  const topicBytes = new TextEncoder().encode(topic);
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const body = new Uint8Array(2 + topicBytes.length + payloadBytes.length);
  body[0] = topicBytes.length >> 8;
  body[1] = topicBytes.length & 0xff;
  body.set(topicBytes, 2);
  body.set(payloadBytes, 2 + topicBytes.length);
  const remaining: number[] = [];
  let length = body.length;
  do {
    let digit = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) digit |= 0x80;
    remaining.push(digit);
  } while (length > 0);
  return Uint8Array.of(0x30, ...remaining, ...body);
}

test('encodes MQTT 3.1.1 credentials and decodes publish frames', () => {
  const connect = encodeConnectPacket({ clientId: 'client', username: 'user', password: 'pass' });
  assert.equal(connect[0], 0x10);
  assert.ok(new TextDecoder().decode(connect).includes('MQTT'));
  const publish = mqttPublish('topic/example', { ok: true });
  const decoded = decodeMqttPackets(publish)[0]!;
  assert.equal(decoded.type, 3);
  assert.equal(decoded.topic, 'topic/example');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(decoded.payload)), { ok: true });
});

class FakeWebSocket implements FiveEPlayWebSocketLike {
  binaryType: BinaryType = 'blob';
  readyState = 0;
  topic: string | null = null;
  readonly #listeners = new Map<string, Set<EventListener>>();

  constructor() {
    queueMicrotask(() => {
      this.readyState = 1;
      this.#emit('open', new Event('open'));
    });
  }

  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: EventListener): void {
    const listeners = this.#listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: EventListener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: ArrayBufferView | ArrayBuffer | Blob | string): void {
    if (typeof data === 'string' || data instanceof Blob) return;
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const decoded: DecodedMqttPacket | undefined = decodeMqttPackets(bytes)[0];
    if (decoded?.type === 1) {
      queueMicrotask(() => this.#message(Uint8Array.of(0x20, 0x02, 0x00, 0x00)));
    } else if (decoded?.type === 8) {
      const topicLength = (decoded.payload[2] ?? 0) * 256 + (decoded.payload[3] ?? 0);
      this.topic = new TextDecoder().decode(decoded.payload.subarray(4, 4 + topicLength));
      queueMicrotask(() => this.#message(Uint8Array.of(0x90, 0x03, 0x00, 0x01, 0x00)));
    }
  }

  publish(payload: unknown): void {
    assert.ok(this.topic);
    this.#message(mqttPublish(this.topic!, payload));
  }

  close(): void {
    this.readyState = 3;
    this.#emit('close', new Event('close'));
  }

  #message(bytes: Uint8Array): void {
    const copy = bytes.slice().buffer;
    this.#emit('message', { data: copy } as MessageEvent<ArrayBuffer>);
  }

  #emit(type: string, event: Event): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

test('maintains a typed snapshot from MQTT state and log updates', async () => {
  const requests: string[] = [];
  const sockets: FakeWebSocket[] = [];
  const session = await createFiveEPlayMatchSession(identity.id, {
    fetch: mockFetch(requests),
    webSocketFactory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
    timeoutMs: 2_000,
  });
  try {
    const iterator = session[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, 'snapshot');
    const stateSocket = sockets.find((socket) => socket.topic?.includes('/detail/'))!;
    stateSocket.publish({
      event_name: 'csgo-detail',
      data: {
        state_ver: '101',
        match: {
          bouts_state: [{
            ...detailData.match.bouts_state[1],
            t1_stats: { ...detailData.match.bouts_state[1]!.t1_stats, all_score: '8', quick_score: '8' },
          }],
        },
      },
    });
    const stateUpdate = await iterator.next();
    assert.equal(stateUpdate.value?.type, 'state');
    assert.equal(stateUpdate.value?.snapshot.current?.teams[0]?.score, 8);

    const logSocket = sockets.find((socket) => socket.topic?.includes('/event/log/'))!;
    logSocket.publish({
      event_name: 'csgo-event-log',
      data: {
        from_ver: '2', to_ver: '3',
        info: {
          update_version: '3', match_id: identity.id, bout_id: `${identity.id}_2`,
          bout_num: '2', map_name: 'Inferno',
          log_info: JSON.stringify({ type: '1', round_start: { round_num: '12', map: 'Inferno', bout_num: '2' } }),
        },
      },
    });
    const logUpdate = await iterator.next();
    assert.equal(logUpdate.value?.type, 'log');
    assert.equal(logUpdate.value?.type === 'log' ? logUpdate.value.event.kind : null, 'round-start');
    assert.equal(session.snapshot().current?.eventLog.events.length, 1);
  } finally {
    await session.close();
  }
  assert.equal(requests.filter((url) => url.includes('/api/restrict/matchscore')).length, 2);
});
