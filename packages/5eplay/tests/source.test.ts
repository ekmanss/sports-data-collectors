import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { createFiveEPlayMatchSource, FiveEPlaySourceError } from '../src/index.js';
import { createFiveEPlayMatchSourceWithTransport } from '../src/api/source.js';
import { waitFor } from '../src/internal/time.js';
import { WatchQueue } from '../src/sync/watch_queue.js';
import type { JsonHttpResponse } from '../src/transport/http.js';
import { MqttTopicClient } from '../src/transport/mqtt.js';
import type { MatchTransport } from '../src/transport/port.js';
import { ReplayTransport } from '../src/transport/replay.js';
import { FakeMqttBroker } from './support/fake_mqtt.js';

const BETWEEN_MAPS_RESPONSE = new URL(
  './fixtures/states/bo3-between-map2-map3.json',
  import.meta.url,
);

const STATE_FIXTURES = './fixtures/states/';

async function filesBelow(directory: URL, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relative = `${prefix}${entry.name}`;
      return entry.isDirectory()
        ? filesBelow(new URL(`${entry.name}/`, directory), `${relative}/`)
        : [relative];
    }),
  );
  return files.flat().sort();
}

async function snapshotFromFixture(path: string) {
  const body = await readFile(new URL(`${STATE_FIXTURES}${path}`, import.meta.url), 'utf8');
  globalThis.fetch = async () =>
    new Response(body, {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
  const parsed = JSON.parse(body) as { data: { match: { mc_info: { id: string } } } };
  const matchId = parsed.data.match.mc_info.id;
  assert.ok(matchId);
  return createFiveEPlayMatchSource({
    timing: { closeCalibrationMs: 1, livePollMs: 1 },
  }).snapshot(matchId);
}

test('snapshot confirms a real BO3 between map 2 and map 3', async (context) => {
  const body = await readFile(BETWEEN_MAPS_RESPONSE, 'utf8');
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(body, {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const source = createFiveEPlayMatchSource();
  const result = await source.snapshot('csgo_mc_2395547');

  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') return;

  assert.equal(result.snapshot.schema, 'fiveeplay-match/v2');
  assert.equal(result.snapshot.match.id, 'csgo_mc_2395547');
  assert.equal(result.snapshot.match.format, 'bo3');
  assert.deepEqual(result.snapshot.state.phase, {
    kind: 'between-maps',
    previousMap: 2,
    nextMap: 3,
  });
  assert.equal(result.snapshot.state.lifecycle, 'live');
  assert.deepEqual(
    result.snapshot.maps.map((map) => ({
      mapNumber: map.mapNumber,
      name: map.name,
      status: map.status,
    })),
    [
      { mapNumber: 1, name: 'Anubis', status: 'settled' },
      { mapNumber: 2, name: 'Cache', status: 'settled' },
      { mapNumber: 3, name: 'Mirage', status: 'unopened' },
    ],
  );
  assert.deepEqual(result.snapshot.maps.map((map) => map.stage), [
    'second-half',
    'second-half',
    null,
  ]);
  assert.deepEqual(result.snapshot.state.providerVector, [1, 2, 2, -1]);
  assert.equal(result.snapshot.maps[1]?.stage, 'second-half');
  assert.equal(result.snapshot.maps[1]?.regulationRoundsPerHalf, 12);
  assert.equal(result.snapshot.maps[1]?.vetoAction, 'pick');
  assert.equal(result.snapshot.maps[1]?.vetoTeamId, 'csgo_tm_10621');
  assert.equal(result.snapshot.seriesWinnerTeamId, null);
  assert.deepEqual(result.snapshot.seriesScore, [
    { teamId: 'csgo_tm_10459', score: 1 },
    { teamId: 'csgo_tm_10621', score: 1 },
  ]);
});

test('replay and production use the same snapshot transport seam', async () => {
  const payload = JSON.parse(await readFile(BETWEEN_MAPS_RESPONSE, 'utf8'));
  const coreFrame = {
    kind: 'ok' as const,
    payload,
    status: 200,
    urlIncludes: '/matches/csgo_mc_2395547/data',
  };
  const source = createFiveEPlayMatchSourceWithTransport(
    {},
    new ReplayTransport([coreFrame, coreFrame]),
  );

  const result = await source.snapshot('csgo_mc_2395547');

  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') return;
  assert.deepEqual(result.snapshot.state.phase, {
    kind: 'between-maps',
    previousMap: 2,
    nextMap: 3,
  });
  assert.equal(result.snapshot.detailsCompleteness, 'partial');
});

test('curated fixture manifest is exact, hash-verified, and credential-free', async () => {
  const fixtureDirectory = new URL('./fixtures/', import.meta.url);
  const manifest = JSON.parse(
    await readFile(new URL('manifest.json', fixtureDirectory), 'utf8'),
  ) as {
    entries: Array<{
      curatedSha256: string;
      file: string;
      originalSha256: string;
      sourceCaptureLabel: string;
    }>;
  };
  const actualFiles = (await filesBelow(fixtureDirectory)).filter(
    (file) => file !== 'manifest.json',
  );
  assert.deepEqual(
    actualFiles,
    manifest.entries.map((entry) => entry.file).sort(),
  );
  const sensitiveKey = /authorization|cookie|credential|password|secret|token/i;
  const inspect = (value: unknown, location: string): void => {
    if (typeof value === 'string' && /^https?:\/\//.test(value)) {
      assert.equal(new URL(value).hostname, 'fixtures.invalid', `${location} has a live URL`);
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(sensitiveKey.test(key), false, `${location}.${key} is credential-shaped`);
      inspect(child, `${location}.${key}`);
    }
  };
  for (const entry of manifest.entries) {
    assert.match(entry.originalSha256, /^[a-f0-9]{64}$/);
    assert.match(entry.sourceCaptureLabel, /^(?:network|observations)\//);
    const bytes = await readFile(new URL(entry.file, fixtureDirectory));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      entry.curatedSha256,
      entry.file,
    );
    inspect(JSON.parse(bytes.toString('utf8')), entry.file);
  }
});

test('snapshot classifies the complete observed BO3 phase matrix', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const cases = [
    {
      file: 'bo3-prestart.json',
      lifecycle: 'scheduled',
      stateCase: 'prestart',
      phase: { kind: 'prestart' },
      vector: [0, -1, -1, -1],
    },
    {
      file: 'bo3-live-map1-unopened.json',
      lifecycle: 'live',
      stateCase: 'map1-unopened',
      phase: { kind: 'map-unopened', map: 1 },
      vector: [1, -1, -1, -1],
    },
    {
      file: 'bo3-map1-live.json',
      lifecycle: 'live',
      stateCase: 'map1-live',
      phase: { kind: 'map-live', map: 1 },
      vector: [1, 1, -1, -1],
    },
    {
      file: 'bo3-between-map1-map2.json',
      lifecycle: 'live',
      stateCase: 'between-map1-map2',
      phase: { kind: 'between-maps', previousMap: 1, nextMap: 2 },
      vector: [1, 2, -1, -1],
    },
    {
      file: 'bo3-map2-live.json',
      lifecycle: 'live',
      stateCase: 'map2-live',
      phase: { kind: 'map-live', map: 2 },
      vector: [1, 2, 1, -1],
    },
    {
      file: 'bo3-between-map2-map3.json',
      lifecycle: 'live',
      stateCase: 'between-map2-map3',
      phase: { kind: 'between-maps', previousMap: 2, nextMap: 3 },
      vector: [1, 2, 2, -1],
    },
    {
      file: 'bo3-map3-live.json',
      lifecycle: 'live',
      stateCase: 'map3-live',
      phase: { kind: 'map-live', map: 3 },
      vector: [1, 2, 2, 1],
    },
    {
      file: 'bo3-complete-two-maps.json',
      lifecycle: 'closed',
      stateCase: 'series-ended-map2-normal',
      phase: { kind: 'series-ended', finalMap: 2 },
      vector: [2, 2, 2, -1],
    },
    {
      file: 'bo3-complete-three-maps.json',
      lifecycle: 'closed',
      stateCase: 'series-ended-map3-normal',
      phase: { kind: 'series-ended', finalMap: 3 },
      vector: [2, 2, 2, 2],
    },
  ] as const;

  for (const fixture of cases) {
    const result = await snapshotFromFixture(fixture.file);
    assert.equal(result.kind, 'confirmed', fixture.file);
    if (result.kind !== 'confirmed') continue;
    assert.equal(result.snapshot.state.lifecycle, fixture.lifecycle, fixture.file);
    if (fixture.lifecycle === 'closed') {
      assert.equal(result.snapshot.state.dataFinality, 'stable', fixture.file);
    }
    assert.equal(result.snapshot.state.stateCase, fixture.stateCase, fixture.file);
    assert.deepEqual(result.snapshot.state.phase, fixture.phase, fixture.file);
    assert.deepEqual(result.snapshot.state.providerVector, fixture.vector, fixture.file);
  }
});

test('snapshot blocks an internally contradictory terminal vector', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const result = await snapshotFromFixture(
    'inconsistent-global-complete-map-live.json',
  );
  assert.deepEqual(result, {
    kind: 'blocked',
    matchId: 'csgo_mc_2396047',
    observedAt: result.kind === 'blocked' ? result.observedAt : null,
    reason: 'inconsistent-state',
  });
});

test('core identity mismatch is blocked as inconsistent rather than mislabeled unsupported', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const body = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-between-map2-map3.json', import.meta.url),
      'utf8',
    ),
  ) as { data: { match: { mc_info: { id: string } } } };
  body.data.match.mc_info.id = 'csgo_mc_9999999';
  globalThis.fetch = async () => Response.json(body);

  const result = await createFiveEPlayMatchSource().snapshot('csgo_mc_2395547');
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.equal(result.reason, 'inconsistent-state');
});

test('a started map must carry explicit team identities before scores are rebound', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const body = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-map1-live.json', import.meta.url),
      'utf8',
    ),
  ) as { data: { match: { bouts_state: Array<{ t1_stats: { id: string } }> } } };
  const firstMap = body.data.match.bouts_state[0];
  assert.ok(firstMap);
  firstMap.t1_stats.id = '';
  globalThis.fetch = async () => Response.json(body);

  const result = await createFiveEPlayMatchSource().snapshot('csgo_mc_2395547');
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.equal(result.reason, 'inconsistent-state');
});

test('HTTP 200 provider failures remain retryable operational blocks', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => Response.json({ errcode: 50301, success: false });

  const result = await createFiveEPlayMatchSource().snapshot('csgo_mc_2395547');
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.equal(result.reason, 'provider-unavailable');
});

test('snapshot rejects an unobserved terminal vector even when stale results look plausible', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const body = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-complete-two-maps.json', import.meta.url),
      'utf8',
    ),
  ) as { data: { match: { bouts_state: Array<{ status: string }> } } };
  const secondMap = body.data.match.bouts_state[1];
  assert.ok(secondMap);
  secondMap.status = '-1';
  globalThis.fetch = async () => Response.json(body);

  const result = await createFiveEPlayMatchSource().snapshot('csgo_mc_2396047');
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.equal(result.reason, 'inconsistent-state');
});

test('an unopened map cannot expose a winner from a stale provider result field', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const body = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-between-map2-map3.json', import.meta.url),
      'utf8',
    ),
  ) as { data: { match: { bouts_state: Array<{ result: string }> } } };
  const thirdMap = body.data.match.bouts_state[2];
  assert.ok(thirdMap);
  thirdMap.result = 't1';
  globalThis.fetch = async () => Response.json(body);

  const result = await createFiveEPlayMatchSource().snapshot('csgo_mc_2395547');
  assert.equal(result.kind, 'confirmed');
  if (result.kind === 'confirmed') assert.equal(result.snapshot.maps[2]?.winnerTeamId, null);
});

test('missing or malformed statistics on an unopened map stay local to that slice', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const body = JSON.parse(
    await readFile(new URL('./fixtures/states/bo3-prestart.json', import.meta.url), 'utf8'),
  ) as {
    data: { match: { bouts_state: Array<Record<string, unknown>> } };
  };
  const firstMap = body.data.match.bouts_state[0];
  assert.ok(firstMap);
  delete firstMap.t1_pr_stats;
  firstMap.t2_pr_stats = { malformed: true };
  globalThis.fetch = async () => Response.json(body);

  const result = await createFiveEPlayMatchSource().snapshot('csgo_mc_2395547');
  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') return;
  assert.equal(result.snapshot.state.stateCase, 'prestart');
  assert.equal(result.snapshot.maps[0].playerStatistics.teams[0].overall.status, 'unavailable');
  assert.equal(result.snapshot.maps[0].playerStatistics.teams[1].overall.status, 'unavailable');
});

test('live series score must agree with settled map winners', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const body = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-between-map1-map2.json', import.meta.url),
      'utf8',
    ),
  ) as { data: { match: { global_state: { t1_score: string } } } };
  body.data.match.global_state.t1_score = '0';
  globalThis.fetch = async () => Response.json(body);

  const result = await createFiveEPlayMatchSource().snapshot('csgo_mc_2395547');
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.equal(result.reason, 'inconsistent-state');
});

test('settled map winner must agree with its final map score', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const body = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-between-map1-map2.json', import.meta.url),
      'utf8',
    ),
  ) as {
    data: {
      match: {
        bouts_state: Array<{
          t1_stats: { all_score: string };
          t2_stats: { all_score: string };
        }>;
      };
    };
  };
  const firstMap = body.data.match.bouts_state[0];
  assert.ok(firstMap);
  firstMap.t1_stats.all_score = '2';
  firstMap.t2_stats.all_score = '13';
  globalThis.fetch = async () => Response.json(body);

  const result = await createFiveEPlayMatchSource().snapshot('csgo_mc_2395547');
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.equal(result.reason, 'inconsistent-state');
});

test('unknown map status is an inconsistent state, not a terminal schema verdict', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const body = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-map1-live.json', import.meta.url),
      'utf8',
    ),
  ) as { data: { match: { bouts_state: Array<{ status: string }> } } };
  const firstMap = body.data.match.bouts_state[0];
  assert.ok(firstMap);
  firstMap.status = '3';
  globalThis.fetch = async () => Response.json(body);

  const result = await createFiveEPlayMatchSource().snapshot('csgo_mc_2395547');
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.equal(result.reason, 'inconsistent-state');
});

test('BO3 map slots are normalized by bout_num rather than provider array order', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const body = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-between-map2-map3.json', import.meta.url),
      'utf8',
    ),
  ) as { data: { match: { bouts_state: unknown[] } } };
  body.data.match.bouts_state.reverse();
  globalThis.fetch = async () => Response.json(body);

  const result = await createFiveEPlayMatchSource().snapshot('csgo_mc_2395547');
  assert.equal(result.kind, 'confirmed');
  if (result.kind === 'confirmed') {
    assert.deepEqual(result.snapshot.maps.map((map) => map.mapNumber), [1, 2, 3]);
    assert.deepEqual(result.snapshot.state.phase, {
      kind: 'between-maps',
      nextMap: 3,
      previousMap: 2,
    });
  }
});

test('snapshot keeps technical map closure distinct from played maps', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const result = await snapshotFromFixture(
    'technical-settlement.json',
  );
  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') return;

  assert.equal(result.snapshot.state.lifecycle, 'closed');
  assert.equal(result.snapshot.state.dataFinality, 'stable');
  assert.equal(result.snapshot.state.stateCase, 'series-ended-map2-administrative');
  assert.equal(result.snapshot.state.closure, 'administrative');
  assert.equal(result.snapshot.seriesWinnerTeamId, 'hltv_team_13599');
  assert.deepEqual(
    result.snapshot.teams.map((team) => ({
      change: team.virtualRankChange,
      trend: team.virtualRankTrend,
    })),
    [
      { change: 9, trend: 'up' },
      { change: 7, trend: 'down' },
    ],
  );
  assert.deepEqual(
    result.snapshot.maps.map((map) => ({
      closedWithoutPlay: map.closedWithoutPlay,
      mapNumber: map.mapNumber,
      played: map.played,
      settled: map.settled,
      status: map.status,
      technicalDisposition: map.technicalDisposition,
    })),
    [
      {
        closedWithoutPlay: false,
        mapNumber: 1,
        played: true,
        settled: true,
        status: 'settled',
        technicalDisposition: null,
      },
      {
        closedWithoutPlay: true,
        mapNumber: 2,
        played: false,
        settled: true,
        status: 'closed-without-play',
        technicalDisposition: 'awarded',
      },
      {
        closedWithoutPlay: true,
        mapNumber: 3,
        played: false,
        settled: true,
        status: 'closed-without-play',
        technicalDisposition: 'unused',
      },
    ],
  );
  assert.deepEqual(result.snapshot.maps.map((map) => map.stage), [
    'second-half',
    null,
    null,
  ]);
  assert.equal(
    result.snapshot.maps[1].playerStatistics.teams[0].overall.status,
    'empty',
  );
  assert.deepEqual(result.snapshot.maps[1].teams.map((team) => team.score), [1, 0]);
  assert.deepEqual(result.snapshot.maps[2].teams.map((team) => team.score), [null, null]);
});

test('missing or malformed statistics on no-play technical maps do not block closure', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const body = JSON.parse(
    await readFile(
      new URL('./fixtures/states/technical-settlement.json', import.meta.url),
      'utf8',
    ),
  ) as {
    data: { match: { bouts_state: Array<Record<string, unknown>> } };
  };
  const awardedMap = body.data.match.bouts_state[1];
  const unusedMap = body.data.match.bouts_state[2];
  assert.ok(awardedMap);
  assert.ok(unusedMap);
  delete awardedMap.t1_pr_stats;
  awardedMap.t2_pr_stats = { malformed: true };
  delete unusedMap.t1_pr_stats;
  unusedMap.t2_pr_stats = { malformed: true };
  globalThis.fetch = async () => Response.json(body);

  const result = await createFiveEPlayMatchSource({
    timing: { closeCalibrationMs: 1, livePollMs: 1 },
  }).snapshot('csgo_mc_2395920');
  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') return;
  assert.equal(result.snapshot.state.stateCase, 'series-ended-map2-administrative');
  assert.equal(result.snapshot.maps[1].playerStatistics.teams[0].overall.status, 'unavailable');
  assert.equal(result.snapshot.maps[2].playerStatistics.teams[1].overall.status, 'unavailable');
});

test('snapshot blocks a settled map without play unless it matches an evidenced technical shape', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const body = JSON.parse(
    await readFile(
      new URL('./fixtures/states/technical-settlement.json', import.meta.url),
      'utf8',
    ),
  ) as {
    data: {
      match: {
        bouts_state: Array<{
          t1_stats: { all_score: string; quick_score: string };
          t2_stats: { all_score: string; quick_score: string };
        }>;
      };
    };
  };
  const awardedMap = body.data.match.bouts_state[1];
  assert.ok(awardedMap);
  awardedMap.t1_stats.all_score = '13';
  awardedMap.t1_stats.quick_score = '13';
  awardedMap.t2_stats.all_score = '6';
  awardedMap.t2_stats.quick_score = '6';
  globalThis.fetch = async () => Response.json(body);

  const result = await createFiveEPlayMatchSource({
    timing: { closeCalibrationMs: 1, livePollMs: 1 },
  }).snapshot('csgo_mc_2395920');

  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.equal(result.reason, 'inconsistent-state');
});

test('series aggregate players decode from global player_stats fields', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const body = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-detail-map1-unopened.json', import.meta.url),
      'utf8',
    ),
  ) as {
    data: {
      match: {
        bouts_state: Array<{ t1_pr_stats: unknown[] }>;
        global_state: { t1_player_stats: unknown[] };
      };
    };
  };
  body.data.match.global_state.t1_player_stats = [
    { alive: '3', hp: '0', id: 'player_1', kevlar: '1', name: 'Fixture Player' },
  ];
  globalThis.fetch = async () => Response.json(body);

  const result = await createFiveEPlayMatchSource().snapshot('csgo_mc_2395918');
  assert.equal(result.kind, 'confirmed');
  if (result.kind === 'confirmed') {
    const rows = result.snapshot.seriesPlayerStatistics.teams[0].overall.rows;
    assert.ok(rows);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.teamId, 'hltv_team_13892');
    assert.equal(rows[0]?.alive, false);
    assert.equal(rows[0]?.hasArmor, true);
  }
});

test('normal terminal statistics keep overall, CT, and T planes distinct', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const [core, fragment] = await Promise.all([
    readFile(
      new URL('./fixtures/states/bo3-complete-three-maps.json', import.meta.url),
      'utf8',
    ).then((value) => JSON.parse(value)),
    readFile(
      new URL('./fixtures/statistics/normal-terminal.json', import.meta.url),
      'utf8',
    ).then((value) => JSON.parse(value)),
  ]) as [
    { data: { match: { bouts_state: Array<Record<string, unknown>>; global_state: Record<string, unknown> } } },
    { globalState: Record<string, unknown>; maps: Array<Record<string, unknown> & { bout_num: string }> },
  ];
  Object.assign(core.data.match.global_state, fragment.globalState);
  for (const mapStatistics of fragment.maps) {
    const target = core.data.match.bouts_state.find(
      (map) => map.bout_num === mapStatistics.bout_num,
    );
    assert.ok(target);
    Object.assign(target, mapStatistics);
  }
  globalThis.fetch = async () => Response.json(core);

  const result = await createFiveEPlayMatchSource({
    timing: { closeCalibrationMs: 1, livePollMs: 1 },
  }).snapshot('csgo_mc_2395547');

  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') return;
  const series = result.snapshot.seriesPlayerStatistics;
  assert.equal(series.teams[0].overall.status, 'present');
  assert.equal(series.teams[0].overall.rows?.length, 5);
  assert.equal(series.teams[0].ct.status, 'empty');
  assert.equal(series.teams[0].t.status, 'empty');
  assert.equal(series.highlights.status, 'present');
  assert.equal(series.highlights.rows?.length, 2);
  assert.equal(series.mvp?.id, 'csgo_pl_20700');
  assert.equal(series.mvp?.teamId, result.snapshot.teams[1].id);
  assert.equal(series.mvp?.killsByOpponent.status, 'partial');
  assert.equal(series.mvp?.killsByOpponent.gap, 'PROVIDER_LIST_MISSING');
  assert.equal(series.mvp?.killsByOpponent.rows?.length, 5);
  assert.equal(series.mvp?.killsByOpponent.rows?.[0]?.providerMarkedMost, null);
  assert.equal(series.mvp?.openingKillsByOpponent.status, 'partial');
  assert.deepEqual(series.mvpChart[0], {
    averageReference: 74.2,
    displayPercent: 83.3,
    key: 'adr',
    normalizedDisplay: 0.83,
    upperReference: 106,
  });

  const firstMap = result.snapshot.maps[0].playerStatistics;
  assert.equal(firstMap.teams[0].overall.rows?.length, 5);
  assert.equal(firstMap.teams[0].ct.rows?.length, 5);
  assert.equal(firstMap.teams[0].t.rows?.length, 5);
  assert.equal(firstMap.teams[1].ct.status, 'present');
  assert.equal(firstMap.teams[1].ct.rows?.length, 5);
  assert.equal(
    firstMap.teams[1].ct.rows?.find((player) => player.id === 'csgo_pl_13239')
      ?.headshotPercent,
    null,
  );
  assert.equal(firstMap.highlights.rows?.length, 4);
  const ryujin = firstMap.teams[0].overall.rows?.find(
    (player) => player.id === 'csgo_pl_19703',
  );
  assert.equal(ryujin?.killDeathDifference, 7);
  assert.equal(ryujin?.headshotPercent, 42.9);
  assert.equal(ryujin?.openingKillPercent, 20);
  assert.equal(ryujin?.multiKillCount, 3);
  assert.equal(ryujin?.killsByOpponent.status, 'present');
  assert.equal(ryujin?.killsByOpponent.rows?.length, 5);

  assert.equal(
    result.snapshot.maps[1].playerStatistics.teams[0].ct.status,
    'unavailable',
  );
  assert.equal(result.snapshot.maps[2].playerStatistics.teams[0].overall.status, 'present');
  assert.equal(result.snapshot.maps[2].playerStatistics.teams[0].ct.status, 'empty');
  assert.equal(result.snapshot.maps[2].playerStatistics.highlights.rows?.length, 1);
});

test('duel rows reject duplicate and same-team opponent identities without losing other stats', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const [core, fragment] = await Promise.all([
    readFile(
      new URL('./fixtures/states/bo3-complete-three-maps.json', import.meta.url),
      'utf8',
    ).then((value) => JSON.parse(value)),
    readFile(
      new URL('./fixtures/statistics/normal-terminal.json', import.meta.url),
      'utf8',
    ).then((value) => JSON.parse(value)),
  ]) as [
    { data: { match: { bouts_state: Array<Record<string, unknown>>; global_state: Record<string, unknown> } } },
    { globalState: Record<string, unknown>; maps: Array<Record<string, unknown> & { bout_num: string }> },
  ];
  const firstMap = fragment.maps[0];
  assert.ok(firstMap);
  const firstTeamRows = firstMap.t1_pr_stats as Array<Record<string, unknown>>;
  const player = firstTeamRows[0];
  const teammate = firstTeamRows[1];
  assert.ok(player);
  assert.ok(teammate);
  const counters = player.counter_kills as Array<Record<string, unknown>>;
  assert.ok(counters[0]);
  assert.ok(counters[1]);
  counters[1].player_id = counters[0].player_id;

  const openings = player.first_kills as Array<Record<string, unknown>>;
  const openingMap = player.first_kill_map as Record<string, unknown>;
  const firstOpening = openings[0];
  assert.ok(firstOpening);
  const oldOpponentId = String(firstOpening.player_id);
  const teammateId = String(teammate.id);
  const openingKills = openingMap[oldOpponentId];
  delete openingMap[oldOpponentId];
  openingMap[teammateId] = openingKills;
  firstOpening.player_id = teammateId;

  Object.assign(core.data.match.global_state, fragment.globalState);
  for (const mapStatistics of fragment.maps) {
    const target = core.data.match.bouts_state.find(
      (map) => map.bout_num === mapStatistics.bout_num,
    );
    assert.ok(target);
    Object.assign(target, mapStatistics);
  }
  globalThis.fetch = async () => Response.json(core);

  const result = await createFiveEPlayMatchSource({
    timing: { closeCalibrationMs: 1, livePollMs: 1 },
  }).snapshot('csgo_mc_2395547');
  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') return;
  const decoded = result.snapshot.maps[0].playerStatistics.teams[0].overall.rows?.find(
    (row) => row.id === player.id,
  );
  assert.ok(decoded);
  assert.equal(decoded.killsByOpponent.status, 'unavailable');
  assert.equal(decoded.killsByOpponent.gap, 'SOURCE_CONFLICT');
  assert.equal(decoded.openingKillsByOpponent.status, 'unavailable');
  assert.equal(decoded.openingKillsByOpponent.gap, 'SOURCE_CONFLICT');
});

test('technical terminal statistics do not mistake empty overall for missing side splits', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const [core, fragment] = await Promise.all([
    readFile(
      new URL('./fixtures/states/technical-settlement.json', import.meta.url),
      'utf8',
    ).then((value) => JSON.parse(value)),
    readFile(
      new URL('./fixtures/statistics/technical-terminal.json', import.meta.url),
      'utf8',
    ).then((value) => JSON.parse(value)),
  ]) as [
    { data: { match: { bouts_state: Array<Record<string, unknown>>; global_state: Record<string, unknown> } } },
    { globalState: Record<string, unknown>; maps: Array<Record<string, unknown> & { bout_num: string }> },
  ];
  Object.assign(core.data.match.global_state, fragment.globalState);
  for (const mapStatistics of fragment.maps) {
    const target = core.data.match.bouts_state.find(
      (map) => map.bout_num === mapStatistics.bout_num,
    );
    assert.ok(target);
    Object.assign(target, mapStatistics);
  }
  globalThis.fetch = async () => Response.json(core);

  const result = await createFiveEPlayMatchSource({
    timing: { closeCalibrationMs: 1, livePollMs: 1 },
  }).snapshot('csgo_mc_2395920');

  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') return;
  const series = result.snapshot.seriesPlayerStatistics;
  assert.equal(series.teams[0].overall.status, 'empty');
  assert.equal(series.teams[0].ct.status, 'present');
  assert.equal(series.teams[0].ct.rows?.length, 5);
  assert.equal(series.teams[0].t.status, 'present');
  assert.equal(series.teams[0].t.rows?.length, 5);
  assert.equal(series.mvp, null);
  assert.deepEqual(series.mvpChart, []);
});

test('snapshot reports BO1 as unverified without manufacturing a state', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const body = JSON.parse(await readFile(BETWEEN_MAPS_RESPONSE, 'utf8')) as {
    data: { match: { mc_info: { format: string } } };
  };
  body.data.match.mc_info.format = '1';
  globalThis.fetch = async () => Response.json(body);

  const result = await createFiveEPlayMatchSource().snapshot('csgo_mc_2395547');
  assert.deepEqual(result, {
    format: '1',
    kind: 'unsupported',
    matchId: 'csgo_mc_2395547',
    reason: 'format-unverified',
  });
});

test('snapshot rejects a non-CS2 provider schema', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const body = JSON.parse(await readFile(BETWEEN_MAPS_RESPONSE, 'utf8')) as {
    data: { match: { mc_info: { match_version: string } } };
  };
  body.data.match.mc_info.match_version = 'csgo';
  globalThis.fetch = async () => Response.json(body);

  const result = await createFiveEPlayMatchSource().snapshot('csgo_mc_2395547');

  assert.deepEqual(result, {
    format: null,
    kind: 'unsupported',
    matchId: 'csgo_mc_2395547',
    reason: 'provider-schema-unsupported',
  });
});

test('snapshot returns all fixed detail sections inside a core revision barrier', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const fixtureNames = [
    'analysis/full.json',
    'states/bo3-detail-map1-unopened.json',
    'team-history/header-recent.json',
    'team-history/header-recent-team2.json',
    'team-history/analysis-recent.json',
    'team-history/analysis-recent-team2.json',
    'community/tabs-empty.json',
  ] as const;
  const fixtures = new Map<string, unknown>();
  for (const name of fixtureNames) {
    fixtures.set(
      name,
      JSON.parse(
        await readFile(
          new URL(`./fixtures/${name}`, import.meta.url),
          'utf8',
        ),
      ),
    );
  }
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url.toString());
    const name =
      url.pathname.endsWith('/matches/csgo_mc_2395918/data')
        ? 'states/bo3-detail-map1-unopened.json'
        : url.pathname.endsWith('/matches/csgo_mc_2395918/analysis_v1')
          ? 'analysis/full.json'
          : url.pathname.endsWith('/teams/hltv_team_13892/matches')
            ? 'team-history/header-recent.json'
            : url.pathname.endsWith('/teams/hltv_team_13528/matches')
              ? 'team-history/header-recent-team2.json'
              : url.pathname.endsWith('/team/matches_v1/hltv_team_13892')
                ? 'team-history/analysis-recent.json'
                : url.pathname.endsWith('/team/matches_v1/hltv_team_13528')
                  ? 'team-history/analysis-recent-team2.json'
                  : url.pathname.endsWith('/match/csgo_mc_2395918/event/log')
                    ? null
                    : url.pathname.endsWith('/api/score/match_score_tab')
                      ? 'community/tabs-empty.json'
                      : null;
    if (url.pathname.endsWith('/match/csgo_mc_2395918/event/log')) {
      return Response.json({
        data: { from_ver: '', list: [], not_more: '', to_ver: '' },
        errcode: 0,
        message: null,
        success: true,
      });
    }
    assert.ok(name, `unexpected request ${url}`);
    return Response.json(fixtures.get(name));
  };

  const result = await createFiveEPlayMatchSource().snapshot('csgo_mc_2395918');
  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') return;

  assert.equal(result.snapshot.detailsCompleteness, 'partial');
  assert.equal(result.snapshot.match.gameVersion, 'cs2');
  assert.deepEqual(
    {
      gradeCode: result.snapshot.tournament.gradeCode,
      gradeLabel: result.snapshot.tournament.gradeLabel,
      providerLocalStartTime: result.snapshot.tournament.providerLocalStartTime,
      status: result.snapshot.tournament.status,
    },
    {
      gradeCode: '5',
      gradeLabel: 'C级赛事',
      providerLocalStartTime: '2026-07-15 00:00:00',
      status: 'live',
    },
  );
  assert.deepEqual(
    {
      backgroundUrl: result.snapshot.maps[0]?.backgroundUrl,
      displayName: result.snapshot.maps[0]?.displayName,
      iconUrl: result.snapshot.maps[0]?.iconUrl,
      regulationRoundsPerHalf: result.snapshot.maps[0]?.regulationRoundsPerHalf,
    },
    {
      backgroundUrl: 'https://fixtures.invalid/assets/3634e74aaf545a44',
      displayName: '第一局',
      iconUrl: 'https://fixtures.invalid/assets/1adc325acb04c89b',
      regulationRoundsPerHalf: 12,
    },
  );
  assert.equal(result.snapshot.details.events.status, 'empty');
  assert.equal(result.snapshot.details.community.status, 'empty');
  assert.equal(result.snapshot.details.analysis.status, 'complete');
  assert.deepEqual(
    result.snapshot.details.analysis.data.teams.map((team) => ({
      teamId: team.teamId,
      winRate: team.winRate,
    })),
    [
      { teamId: 'hltv_team_13892', winRate: 44 },
      { teamId: 'hltv_team_13528', winRate: 44 },
    ],
  );
  assert.equal(result.snapshot.details.analysis.data.maps[0]?.name, 'Mirage');
  assert.equal(result.snapshot.details.analysis.data.maps[0]?.vetoAction, 'pick');
  assert.equal(
    result.snapshot.details.analysis.data.maps[0]?.vetoTeamId,
    'hltv_team_13892',
  );
  assert.equal(result.snapshot.details.analysis.data.maps[2]?.vetoAction, 'left');
  assert.equal(result.snapshot.details.analysis.data.maps[2]?.vetoTeamId, null);
  assert.equal(result.snapshot.details.analysis.data.maps[0]?.teams[1].matches, 13);
  assert.equal(result.snapshot.details.analysis.data.maps[0]?.teams[1].wins, null);
  assert.equal(
    result.snapshot.details.analysis.data.tournament.providerLocalEndTime,
    '2026-07-20 23:59:59',
  );
  assert.deepEqual(
    {
      hltvRating: result.snapshot.details.analysis.data.power[0][0]?.hltvRating,
      portraitUrl: result.snapshot.details.analysis.data.power[0][0]?.portraitUrl,
      side: result.snapshot.details.analysis.data.power[0][0]?.side,
      sideLabel: result.snapshot.details.analysis.data.power[0][0]?.sideLabel,
      timeFrameCode: result.snapshot.details.analysis.data.power[0][0]?.timeFrameCode,
    },
    {
      hltvRating: 1.06,
      portraitUrl: 'https://fixtures.invalid/assets/4234a32205f369f9',
      side: 'all',
      sideLabel: '全阵营',
      timeFrameCode: '3',
    },
  );
  assert.equal(
    result.snapshot.details.analysis.data.power[0][0]?.metrics[0]?.iconUrl,
    'https://fixtures.invalid/assets/f3d69e711bde083e',
  );
  assert.equal(result.snapshot.details.teamRecentMatches.status, 'partial');
  assert.equal(result.snapshot.details.teamRecentMatches.data[0]?.teamId, 'hltv_team_13892');
  assert.equal(result.snapshot.details.teamRecentMatches.data[0]?.totalRows, 8);
  assert.equal(
    result.snapshot.details.teamRecentMatches.data[0]?.tournaments[0]?.tournament.location,
    '欧洲，线上',
  );
  assert.equal(
    result.snapshot.details.teamRecentMatches.data[0]?.tournaments[0]?.matches[0]?.gradeCode,
    '5',
  );
  assert.equal(
    result.snapshot.details.teamRecentMatches.data[0]?.tournaments[0]?.matches[0]?.lifecycle,
    'past',
  );
  assert.equal(
    result.snapshot.details.teamRecentMatches.data[0]?.tournaments[0]?.matches[0]
      ?.providerStatusCode,
    null,
  );
  assert.equal(result.snapshot.details.teamPastMatches.status, 'partial');
  assert.equal(result.snapshot.details.teamPastMatches.data[0]?.teamId, 'hltv_team_13892');
  assert.equal(result.snapshot.details.teamPastMatches.data[0]?.matches.length, 8);
  assert.equal(result.snapshot.details.teamPastMatches.data[0]?.matches[0]?.lifecycle, 'past');
  assert.equal(result.snapshot.details.teamPastMatches.data[0]?.matches[0]?.providerStatusCode, '2');
  assert.equal(
    requests.filter((request) => request.endsWith('/matches/csgo_mc_2395918/data')).length,
    2,
  );
  assert.equal(
    requests.filter((request) =>
      request.includes('/teams/hltv_team_13528/matches?page='),
    ).length,
    3,
  );
  assert.equal(
    requests.filter((request) =>
      request.includes('/team/matches_v1/hltv_team_13528?page='),
    ).length,
    2,
  );
});

test('event history ignores not_more and paginates from the oldest version', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const [core, firstPage, secondPage] = await Promise.all(
    [
      'states/bo3-between-map2-map3.json',
      'events/page-1.json',
      'events/page-2.json',
    ].map(async (name) =>
      JSON.parse(
        await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
      ),
    ),
  );
  const cursors: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) {
      return Response.json(core);
    }
    if (url.pathname.endsWith('/match/csgo_mc_2395547/event/log')) {
      const cursor = url.searchParams.get('update_version') ?? '';
      cursors.push(cursor);
      return Response.json(cursor === '0' ? firstPage : secondPage);
    }
    return new Response(null, { status: 404 });
  };

  const result = await createFiveEPlayMatchSource({
    limits: { eventPageSize: 6 },
  }).snapshot('csgo_mc_2395547');
  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') return;

  assert.equal(result.snapshot.details.events.status, 'complete');
  assert.equal(result.snapshot.details.events.data.length, 11);
  assert.deepEqual(cursors, ['0', '1784543714790', '0']);
  const versions = result.snapshot.details.events.data.map((event) =>
    BigInt(event.updateVersion),
  );
  assert.deepEqual(versions, [...versions].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  assert.equal(new Set(versions.map(String)).size, versions.length);
  const kill = result.snapshot.details.events.data.find(
    (event) => event.updateVersion === '1784543736818',
  );
  assert.equal(kill?.type, '8');
  assert.equal(kill?.actorPlayerId, 'csgo_pl_23477');
  assert.equal(kill?.targetPlayerId, 'csgo_pl_21363');
  assert.equal(kill?.mapNumber, 1);
  assert.equal(kill?.mapName, 'Anubis');
  assert.equal(kill?.tournamentId, 'csgo_tt_9246');
  assert.equal(kill?.attributes.weapon, 'galilar');
  assert.equal(kill?.attributes.assist_assister_name, 'Qikert');
  const roundStart = result.snapshot.details.events.data.find((event) => event.type === '1');
  assert.equal(roundStart?.roundNumber, 2);
  assert.equal(roundStart?.attributes.map, 'Anubis');
  const roundEnd = result.snapshot.details.events.data.find((event) => event.type === '2');
  assert.equal(roundEnd?.attributes.winner, 'T');
  assert.equal(roundEnd?.attributes.win_type, 'Terrorists_Win');
});

test('event history bridges a growing head and verifies it is stable before complete', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const [core, firstPage, secondPage] = await Promise.all(
    [
      'states/bo3-between-map2-map3.json',
      'events/page-1.json',
      'events/page-2.json',
    ].map(async (name) =>
      JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')),
    ),
  );
  const grownHead = structuredClone(firstPage);
  const newest = structuredClone(firstPage.data.list[0]);
  newest.update_version = '1784543737000';
  grownHead.data.list = [newest, ...grownHead.data.list.slice(0, 5)];
  const cursors: string[] = [];
  let headReads = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) return Response.json(core);
    if (url.pathname.endsWith('/match/csgo_mc_2395547/event/log')) {
      const cursor = url.searchParams.get('update_version') ?? '';
      cursors.push(cursor);
      if (cursor !== '0') return Response.json(secondPage);
      headReads += 1;
      return Response.json(headReads === 1 ? firstPage : grownHead);
    }
    return new Response(null, { status: 404 });
  };

  const result = await createFiveEPlayMatchSource({
    limits: { eventPageSize: 6 },
  }).snapshot('csgo_mc_2395547');

  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') return;
  assert.equal(result.snapshot.details.events.status, 'complete');
  assert.equal(result.snapshot.details.events.data.length, 12);
  assert.deepEqual(cursors, ['0', '1784543714790', '0', '0']);
  assert.equal(
    result.snapshot.details.events.data.at(-1)?.updateVersion,
    '1784543737000',
  );
});

test('event history rejects a stable head that deleted earlier head events', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const [core, fixturePage] = await Promise.all(
    ['states/bo3-between-map2-map3.json', 'events/page-1.json'].map(async (name) =>
      JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')),
    ),
  );
  const initial = structuredClone(fixturePage);
  initial.data.list = initial.data.list.slice(0, 3);
  const regressed = structuredClone(initial);
  const newEvent = structuredClone(initial.data.list[0]);
  newEvent.update_version = '1784543737000';
  regressed.data.list = [newEvent, initial.data.list[2]];
  let headReads = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) return Response.json(core);
    if (url.pathname.endsWith('/match/csgo_mc_2395547/event/log')) {
      headReads += 1;
      return Response.json(headReads === 1 ? initial : regressed);
    }
    return new Response(null, { status: 404 });
  };

  const result = await createFiveEPlayMatchSource({
    limits: { eventPageSize: 10 },
  }).snapshot('csgo_mc_2395547');

  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') return;
  assert.equal(result.snapshot.details.events.status, 'partial');
  assert.equal(result.snapshot.details.events.gap, 'HEAD_REGRESSED');
});

test('event identity must agree with the confirmed tournament and map', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const [core, page] = await Promise.all(
    ['states/bo3-between-map2-map3.json', 'events/page-1.json'].map(async (name) =>
      JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')),
    ),
  );
  page.data.list[0].tt_id = 'csgo_tt_wrong';
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) return Response.json(core);
    if (url.pathname.endsWith('/match/csgo_mc_2395547/event/log')) {
      return Response.json(page);
    }
    return new Response(null, { status: 404 });
  };

  const result = await createFiveEPlayMatchSource({
    limits: { eventPageSize: 500 },
  }).snapshot('csgo_mc_2395547');

  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') return;
  assert.equal(result.snapshot.details.events.status, 'unavailable');
  assert.equal(
    result.snapshot.details.events.gap,
    'EVENT_IDENTITY_OR_SCHEMA_MISMATCH',
  );
});

test('event history reports a gap when a safety limit truncates pagination', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const [core, firstPage] = await Promise.all(
    ['states/bo3-between-map2-map3.json', 'events/page-1.json'].map(async (name) =>
      JSON.parse(
        await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
      ),
    ),
  );
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) return Response.json(core);
    if (url.pathname.endsWith('/match/csgo_mc_2395547/event/log')) {
      return Response.json(firstPage);
    }
    return new Response(null, { status: 404 });
  };

  const result = await createFiveEPlayMatchSource({
    limits: { eventPageSize: 6 },
  }).snapshot('csgo_mc_2395547', { eventLimits: { maxPages: 1 } });
  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') return;
  assert.equal(result.snapshot.details.events.status, 'partial');
  assert.equal(result.snapshot.details.events.gap, 'PAGE_LIMIT');
  assert.equal(result.snapshot.details.events.data.length, 6);
  assert.equal(result.snapshot.detailsCompleteness, 'partial');
});

test('event limit remains partial when it truncates a short final page', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const [core, shortPage] = await Promise.all(
    ['states/bo3-between-map2-map3.json', 'events/page-2.json'].map(async (name) =>
      JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')),
    ),
  );
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) return Response.json(core);
    if (url.pathname.endsWith('/match/csgo_mc_2395547/event/log')) {
      return Response.json(shortPage);
    }
    return new Response(null, { status: 404 });
  };

  const result = await createFiveEPlayMatchSource({
    limits: { eventPageSize: 6 },
  }).snapshot('csgo_mc_2395547', { eventLimits: { maxEvents: 3 } });
  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') return;
  assert.equal(result.snapshot.details.events.status, 'partial');
  assert.equal(result.snapshot.details.events.gap, 'EVENT_LIMIT');
  assert.equal(result.snapshot.details.events.data.length, 3);
});

test('watch starts blocked, then atomically publishes the first confirmed state', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  const core = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-live-map1-unopened.json', import.meta.url),
      'utf8',
    ),
  );
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) return Response.json(core);
    return new Response(null, { status: 404 });
  };

  const watch = createFiveEPlayMatchSource({ timing: { livePollMs: 50 } }).watch(
    'csgo_mc_2395547',
  );
  assert.equal(watch.current(), null);
  const iterator = watch[Symbol.asyncIterator]();

  const initializing = await iterator.next();
  assert.equal(initializing.done, false);
  assert.equal(initializing.value?.kind, 'blocked');
  if (initializing.value?.kind === 'blocked') {
    assert.equal(initializing.value.reason, 'initializing');
    assert.equal(initializing.value.lastConfirmed, null);
  }

  const confirmed = await iterator.next();
  assert.equal(confirmed.done, false);
  assert.equal(confirmed.value?.kind, 'confirmed-state');
  if (confirmed.value?.kind === 'confirmed-state') {
    assert.equal(confirmed.value.observation.state.phase.kind, 'map-unopened');
    assert.equal(watch.current()?.revision, confirmed.value.observation.revision);
    assert.strictEqual(watch.current(), confirmed.value.observation);
  }

  await watch[Symbol.asyncDispose]();
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test('disposing a watch waits for an in-flight confirmation and prevents a late state', async () => {
  const core = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-live-map1-unopened.json', import.meta.url),
      'utf8',
    ),
  );
  let announceCoreStarted!: () => void;
  const coreStarted = new Promise<void>((resolve) => {
    announceCoreStarted = resolve;
  });
  let resolveCore!: (response: JsonHttpResponse) => void;
  const pendingCore = new Promise<JsonHttpResponse>((resolve) => {
    resolveCore = resolve;
  });
  const transport: MatchTransport = {
    createRealtimeTopic(options) {
      let closed = false;
      return {
        close() {
          closed = true;
        },
        closed: async () => undefined,
        start() {
          queueMicrotask(() => {
            if (!closed && !options.signal.aborted) options.onStatus('connected', null);
          });
        },
      };
    },
    async fetchCore() {
      announceCoreStarted();
      return pendingCore;
    },
    async fetchJsonWithRetry() {
      throw new Error('detail HTTP is not used by watch');
    },
  };
  const watch = createFiveEPlayMatchSourceWithTransport({}, transport).watch(
    'csgo_mc_2395547',
  );
  const iterator = watch[Symbol.asyncIterator]();
  const initializing = await iterator.next();
  assert.equal(initializing.value?.kind, 'blocked');
  await coreStarted;

  let disposed = false;
  const disposal = watch[Symbol.asyncDispose]().then(() => {
    disposed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposed, false);

  resolveCore({
    kind: 'ok',
    observedAt: Date.now() as JsonHttpResponse['observedAt'],
    payload: core,
    retryAfterMs: null,
    status: 200,
  });
  await disposal;

  assert.equal(watch.current(), null);
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test('watch keeps MQTT state provisional until HTTP confirms it', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  const [baseline, live, mqttFixture] = await Promise.all(
    [
      'states/bo3-live-map1-unopened.json',
      'states/bo3-map1-live.json',
      'mqtt/detail-normal.json',
    ].map(async (name) =>
      JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')),
    ),
  );
  let dataRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) {
      dataRequests += 1;
      return Response.json(dataRequests === 1 ? baseline : live);
    }
    return new Response(null, { status: 404 });
  };
  const watch = createFiveEPlayMatchSource({ timing: { livePollMs: 60_000 } }).watch(
    'csgo_mc_2395547',
  );
  const iterator = watch[Symbol.asyncIterator]();
  await iterator.next();
  const initial = await iterator.next();
  assert.equal(initial.value?.kind, 'confirmed-state');
  const initialRevision = watch.current()?.revision;
  assert.ok(initialRevision);

  const mqtt = structuredClone(mqttFixture.payload) as {
    data: { from_ver: string; this_ver: string };
  };
  mqtt.data.from_ver = baseline.data.state_ver;
  mqtt.data.this_ver = `${BigInt(baseline.data.state_ver) + 1n}`.padStart(
    baseline.data.state_ver.length,
    '0',
  );
  broker.publish('csgo/product/detail/csgo_mc_2395547', mqtt);

  const provisional = await iterator.next();
  assert.equal(provisional.value?.kind, 'provisional-telemetry');
  if (provisional.value?.kind === 'provisional-telemetry') {
    assert.equal(provisional.value.telemetry.source, 'state-topic');
    assert.deepEqual(provisional.value.telemetry.mapNumbers, [1]);
    assert.equal(provisional.value.revision, initialRevision);
  }
  assert.equal(watch.current()?.revision, initialRevision);

  const confirmed = await iterator.next();
  assert.equal(confirmed.value?.kind, 'confirmed-state');
  if (confirmed.value?.kind === 'confirmed-state') {
    assert.deepEqual(confirmed.value.observation.state.phase, { kind: 'map-live', map: 1 });
    assert.notEqual(confirmed.value.observation.revision, initialRevision);
    assert.strictEqual(watch.current(), confirmed.value.observation);
  }
  await watch[Symbol.asyncDispose]();
});

test('snapshot enforces expectedRevision before and after detail collection', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const [between, liveMap3] = await Promise.all(
    ['bo3-between-map2-map3.json', 'bo3-map3-live.json'].map(async (name) =>
      JSON.parse(
        await readFile(new URL(`./fixtures/states/${name}`, import.meta.url), 'utf8'),
      ),
    ),
  );
  let coreResponses: unknown[] = [between, between];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) {
      return Response.json(coreResponses.shift() ?? liveMap3);
    }
    return new Response(null, { status: 404 });
  };
  const source = createFiveEPlayMatchSource();
  const initial = await source.snapshot('csgo_mc_2395547');
  assert.equal(initial.kind, 'confirmed');
  if (initial.kind !== 'confirmed') return;

  coreResponses = [between, liveMap3];
  const result = await source.snapshot('csgo_mc_2395547', {
    expectedRevision: initial.snapshot.revision,
  });
  assert.equal(result.kind, 'superseded');
  if (result.kind === 'superseded') {
    assert.equal(result.expectedRevision, initial.snapshot.revision);
    assert.notEqual(result.observedRevision, initial.snapshot.revision);
  }
});

test('the revision barrier detects live score changes without a phase change', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const live = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-map1-live.json', import.meta.url),
      'utf8',
    ),
  ) as {
    data: {
      match: {
        bouts_state: Array<{
          curr_round_num: string;
          t1_stats: {
            all_score: string;
            fh_data: number[];
            fh_score: string;
            quick_score: string;
          };
        }>;
      };
    };
  };
  const changed = structuredClone(live);
  const firstMap = changed.data.match.bouts_state[0];
  assert.ok(firstMap);
  firstMap.t1_stats.all_score = String(Number(firstMap.t1_stats.all_score) + 1);
  firstMap.t1_stats.quick_score = firstMap.t1_stats.all_score;
  firstMap.t1_stats.fh_score = firstMap.t1_stats.all_score;
  firstMap.t1_stats.fh_data.push(1);
  firstMap.curr_round_num = String(Number(firstMap.curr_round_num) + 1);
  const coreResponses: unknown[] = [live, live, live, changed];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/data')) return Response.json(coreResponses.shift() ?? changed);
    return new Response(null, { status: 404 });
  };
  const source = createFiveEPlayMatchSource();
  const initial = await source.snapshot('csgo_mc_2395547');
  assert.equal(initial.kind, 'confirmed');
  if (initial.kind !== 'confirmed') return;

  const result = await source.snapshot('csgo_mc_2395547', {
    expectedRevision: initial.snapshot.revision,
  });
  assert.equal(result.kind, 'superseded');
});

test('provider version churn alone does not make a semantic snapshot unreadable', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const before = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-map1-live.json', import.meta.url),
      'utf8',
    ),
  );
  const after = structuredClone(before);
  after.data.state_ver = `${BigInt(before.data.state_ver) + 1n}`.padStart(
    before.data.state_ver.length,
    '0',
  );
  let requests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/data')) {
      requests += 1;
      return Response.json(requests === 1 ? before : after);
    }
    return new Response(null, { status: 404 });
  };

  const result = await createFiveEPlayMatchSource().snapshot('csgo_mc_2395547');
  assert.equal(result.kind, 'confirmed');
  if (result.kind === 'confirmed') {
    assert.equal(result.snapshot.freshness.stateVersion, after.data.state_ver);
  }
  assert.equal(requests, 2);
});

test('snapshot without expectedRevision retries one drifting barrier exactly once', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const [between, liveMap3] = await Promise.all(
    ['bo3-between-map2-map3.json', 'bo3-map3-live.json'].map(async (name) =>
      JSON.parse(
        await readFile(new URL(`./fixtures/states/${name}`, import.meta.url), 'utf8'),
      ),
    ),
  );
  const coreResponses: unknown[] = [between, liveMap3, liveMap3, liveMap3];
  let dataRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) {
      dataRequests += 1;
      return Response.json(coreResponses.shift());
    }
    return new Response(null, { status: 404 });
  };

  const result = await createFiveEPlayMatchSource().snapshot('csgo_mc_2395547');
  assert.equal(result.kind, 'confirmed');
  if (result.kind === 'confirmed') {
    assert.deepEqual(result.snapshot.state.phase, { kind: 'map-live', map: 3 });
  }
  assert.equal(dataRequests, 4);
});

test('BP invalidation cannot promote a prestart match without HTTP confirmation', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  const [prestart, bpFixture] = await Promise.all(
    ['states/bo3-prestart.json', 'mqtt/detail-bp.json'].map(async (name) =>
      JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')),
    ),
  );
  let dataRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) {
      dataRequests += 1;
      return Response.json(prestart);
    }
    return new Response(null, { status: 404 });
  };
  const watch = createFiveEPlayMatchSource({
    timing: { nearStartPollMs: 60_000, prestartPollMs: 60_000 },
  }).watch('csgo_mc_2395547');
  const iterator = watch[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();

  broker.publish('csgo/product/detail/csgo_mc_2395547', bpFixture.payload);
  const resyncing = await iterator.next();
  assert.equal(resyncing.value?.kind, 'blocked');
  if (resyncing.value?.kind === 'blocked') assert.equal(resyncing.value.reason, 'resyncing');
  for (let attempt = 0; attempt < 20 && dataRequests < 2; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(dataRequests >= 2);
  assert.deepEqual(watch.current()?.state.phase, { kind: 'prestart' });
  await watch[Symbol.asyncDispose]();
});

test('zero-version MQTT does not advance the ordinary cursor and a gap blocks', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  const [baseline, zeroFixture, ordinaryFixture] = await Promise.all(
    [
      'states/bo3-live-map1-unopened.json',
      'mqtt/detail-zero.json',
      'mqtt/detail-normal.json',
    ].map(async (name) =>
      JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')),
    ),
  );
  let dataRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) {
      dataRequests += 1;
      return Response.json(baseline);
    }
    return new Response(null, { status: 404 });
  };
  const watch = createFiveEPlayMatchSource({ timing: { livePollMs: 60_000 } }).watch(
    'csgo_mc_2395547',
  );
  context.after(async () => watch[Symbol.asyncDispose]());
  const iterator = watch[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  const confirmedRevision = watch.current()?.revision;

  broker.publish('csgo/product/detail/csgo_mc_2395547', zeroFixture.payload);
  const zeroUpdate = await iterator.next();
  assert.equal(zeroUpdate.value?.kind, 'blocked');
  if (zeroUpdate.value?.kind === 'blocked') assert.equal(zeroUpdate.value.reason, 'resyncing');
  for (let attempt = 0; attempt < 20 && dataRequests < 2; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const zeroRecovery = await iterator.next();
  assert.equal(zeroRecovery.value?.kind, 'confirmed-state');

  const ordinary = structuredClone(ordinaryFixture.payload) as {
    data: { from_ver: string; this_ver: string };
  };
  ordinary.data.from_ver = baseline.data.state_ver;
  ordinary.data.this_ver = `${BigInt(baseline.data.state_ver) + 1n}`.padStart(
    baseline.data.state_ver.length,
    '0',
  );
  broker.publish('csgo/product/detail/csgo_mc_2395547', ordinary);
  const provisional = await iterator.next();
  assert.equal(provisional.value?.kind, 'provisional-telemetry');

  const gap = structuredClone(ordinary) as typeof ordinary;
  gap.data.from_ver = `${BigInt(ordinary.data.this_ver) + 10n}`.padStart(
    ordinary.data.this_ver.length,
    '0',
  );
  gap.data.this_ver = `${BigInt(gap.data.from_ver) + 1n}`.padStart(
    gap.data.from_ver.length,
    '0',
  );
  broker.publish('csgo/product/detail/csgo_mc_2395547', gap);
  const blocked = await iterator.next();
  assert.equal(blocked.value?.kind, 'blocked');
  if (blocked.value?.kind === 'blocked') {
    assert.equal(blocked.value.reason, 'version-gap');
    assert.equal(blocked.value.lastConfirmed?.revision, confirmedRevision);
  }
  assert.equal(watch.current()?.revision, confirmedRevision);
  await watch[Symbol.asyncDispose]();
});

test('a fork sharing an already consumed MQTT from-version triggers HTTP resync', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  const [baseline, ordinaryFixture] = await Promise.all(
    ['states/bo3-live-map1-unopened.json', 'mqtt/detail-normal.json'].map(async (name) =>
      JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')),
    ),
  );
  const confirmedNext = structuredClone(baseline);
  const fromVersion = baseline.data.state_ver as string;
  const toVersion = `${BigInt(fromVersion) + 1n}`.padStart(fromVersion.length, '0');
  confirmedNext.data.state_ver = toVersion;
  let coreRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) {
      coreRequests += 1;
      return Response.json(coreRequests === 1 ? baseline : confirmedNext);
    }
    return new Response(null, { status: 404 });
  };
  const watch = createFiveEPlayMatchSource({ timing: { livePollMs: 60_000 } }).watch(
    'csgo_mc_2395547',
  );
  context.after(async () => watch[Symbol.asyncDispose]());
  const iterator = watch[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();

  const ordinary = structuredClone(ordinaryFixture.payload) as {
    data: { from_ver: string; this_ver: string };
  };
  ordinary.data.from_ver = fromVersion;
  ordinary.data.this_ver = toVersion;
  broker.publish('csgo/product/detail/csgo_mc_2395547', ordinary);
  assert.equal((await iterator.next()).value?.kind, 'provisional-telemetry');
  assert.equal((await iterator.next()).value?.kind, 'confirmed-state');

  const fork = structuredClone(ordinary);
  fork.data.this_ver = `${BigInt(toVersion) + 1n}`.padStart(toVersion.length, '0');
  broker.publish('csgo/product/detail/csgo_mc_2395547', fork);
  const update = await Promise.race([
    iterator.next(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 20)),
  ]);
  assert.notEqual(update, null);
  assert.equal(update?.value?.kind, 'blocked');
  if (update?.value?.kind === 'blocked') assert.equal(update.value.reason, 'version-gap');
  await watch[Symbol.asyncDispose]();
});

test('watch buffers MQTT received while the HTTP baseline is in flight', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  const [baseline, live, ordinaryFixture] = await Promise.all(
    [
      'states/bo3-live-map1-unopened.json',
      'states/bo3-map1-live.json',
      'mqtt/detail-normal.json',
    ].map(async (name) =>
      JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')),
    ),
  );
  const baselineGate: { resolve: (() => void) | null } = { resolve: null };
  let dataRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) {
      dataRequests += 1;
      if (dataRequests === 1) {
        return new Promise<Response>((resolve) => {
          baselineGate.resolve = () => resolve(Response.json(baseline));
        });
      }
      return Response.json(live);
    }
    return new Response(null, { status: 404 });
  };
  const watch = createFiveEPlayMatchSource({ timing: { livePollMs: 60_000 } }).watch(
    'csgo_mc_2395547',
  );
  const iterator = watch[Symbol.asyncIterator]();
  await iterator.next();
  for (let attempt = 0; attempt < 20 && baselineGate.resolve === null; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const resolveBaseline = baselineGate.resolve;
  assert.ok(resolveBaseline);

  const ordinary = structuredClone(ordinaryFixture.payload) as {
    data: { from_ver: string; this_ver: string };
  };
  ordinary.data.from_ver = baseline.data.state_ver;
  ordinary.data.this_ver = `${BigInt(baseline.data.state_ver) + 1n}`.padStart(
    baseline.data.state_ver.length,
    '0',
  );
  broker.publish('csgo/product/detail/csgo_mc_2395547', ordinary);
  resolveBaseline();

  const baselineUpdate = await iterator.next();
  assert.equal(baselineUpdate.value?.kind, 'confirmed-state');
  if (baselineUpdate.value?.kind === 'confirmed-state') {
    assert.deepEqual(baselineUpdate.value.observation.state.phase, {
      kind: 'map-unopened',
      map: 1,
    });
  }
  const buffered = await iterator.next();
  assert.equal(buffered.value?.kind, 'provisional-telemetry');
  const confirmed = await iterator.next();
  assert.equal(confirmed.value?.kind, 'confirmed-state');
  if (confirmed.value?.kind === 'confirmed-state') {
    assert.deepEqual(confirmed.value.observation.state.phase, { kind: 'map-live', map: 1 });
  }
  assert.equal(dataRequests, 2);
  await watch[Symbol.asyncDispose]();
});

test('periodic HTTP confirms a rollback even when MQTT is silent', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  const [live, prestart] = await Promise.all(
    ['bo3-live-map1-unopened.json', 'bo3-prestart.json'].map(async (name) =>
      JSON.parse(
        await readFile(new URL(`./fixtures/states/${name}`, import.meta.url), 'utf8'),
      ),
    ),
  );
  let dataRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) {
      dataRequests += 1;
      return Response.json(dataRequests === 1 ? live : prestart);
    }
    return new Response(null, { status: 404 });
  };
  const watch = createFiveEPlayMatchSource({ timing: { livePollMs: 2 } }).watch(
    'csgo_mc_2395547',
  );
  const iterator = watch[Symbol.asyncIterator]();
  await iterator.next();
  const first = await iterator.next();
  assert.equal(first.value?.kind, 'confirmed-state');
  const rolledBack = await iterator.next();
  assert.equal(rolledBack.value?.kind, 'confirmed-state');
  if (rolledBack.value?.kind === 'confirmed-state') {
    assert.equal(rolledBack.value.observation.state.lifecycle, 'scheduled');
    assert.deepEqual(rolledBack.value.observation.state.phase, { kind: 'prestart' });
  }
  assert.ok(dataRequests >= 2);
  await watch[Symbol.asyncDispose]();
});

test('state-topic disconnect blocks until reconnect and HTTP resync', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  const core = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-live-map1-unopened.json', import.meta.url),
      'utf8',
    ),
  );
  let dataRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) {
      dataRequests += 1;
      return Response.json(core);
    }
    return new Response(null, { status: 404 });
  };
  const watch = createFiveEPlayMatchSource({
    timing: { livePollMs: 60_000, reconnectInitialMs: 1 },
  }).watch('csgo_mc_2395547');
  const iterator = watch[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  const revision = watch.current()?.revision;

  broker.disconnect('csgo/product/detail/csgo_mc_2395547');
  const unavailable = await iterator.next();
  assert.equal(unavailable.value?.kind, 'blocked');
  if (unavailable.value?.kind === 'blocked') {
    assert.equal(unavailable.value.reason, 'realtime-unavailable');
    assert.equal(unavailable.value.lastConfirmed?.revision, revision);
  }
  const resyncing = await iterator.next();
  assert.equal(resyncing.value?.kind, 'blocked');
  if (resyncing.value?.kind === 'blocked') assert.equal(resyncing.value.reason, 'resyncing');
  for (let attempt = 0; attempt < 20 && dataRequests < 2; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(dataRequests >= 2);
  assert.equal(watch.current()?.revision, revision);
  const recovered = await iterator.next();
  assert.equal(recovered.value?.kind, 'confirmed-state');
  if (recovered.value?.kind === 'confirmed-state') {
    assert.equal(recovered.value.observation.revision, revision);
  }
  await watch[Symbol.asyncDispose]();
});

test('an HTTP request started before state-topic disconnect cannot publish confirmation', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  const core = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-live-map1-unopened.json', import.meta.url),
      'utf8',
    ),
  );
  let releaseCore: (() => void) | null = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) {
      return new Promise<Response>((resolve) => {
        releaseCore = () => resolve(Response.json(core));
      });
    }
    return new Response(null, { status: 404 });
  };
  const watch = createFiveEPlayMatchSource({
    timing: { reconnectInitialMs: 60_000 },
  }).watch('csgo_mc_2395547');
  context.after(async () => watch[Symbol.asyncDispose]());
  const iterator = watch[Symbol.asyncIterator]();
  await iterator.next();
  for (let attempt = 0; attempt < 20 && releaseCore === null; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const release = releaseCore as (() => void) | null;
  assert.ok(release);
  broker.disconnect('csgo/product/detail/csgo_mc_2395547');
  const unavailable = await iterator.next();
  assert.equal(unavailable.value?.kind, 'blocked');
  if (unavailable.value?.kind === 'blocked') {
    assert.equal(unavailable.value.reason, 'realtime-unavailable');
  }
  release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(watch.current(), null);
  await watch[Symbol.asyncDispose]();
});

test('state messages buffered by an old connection are discarded across reconnect', async () => {
  const original = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-live-map1-unopened.json', import.meta.url),
      'utf8',
    ),
  );
  const reconnected = structuredClone(original);
  const firstVersion = original.data.state_ver as string;
  reconnected.data.state_ver = `${BigInt(firstVersion) + 2n}`.padStart(
    firstVersion.length,
    '0',
  );
  let stateStatus: ((status: 'connected' | 'disconnected', error: unknown | null) => void) | null = null;
  let statePayload: ((payload: unknown) => void) | null = null;
  let coreReads = 0;
  let releaseFirst: (() => void) | null = null;
  const response = (payload: unknown): JsonHttpResponse => ({
    kind: 'ok',
    observedAt: Date.now() as JsonHttpResponse['observedAt'],
    payload,
    retryAfterMs: null,
    status: 200,
  });
  const transport: MatchTransport = {
    createRealtimeTopic(options) {
      const isState = options.topic.includes('/detail/');
      if (isState) {
        stateStatus = options.onStatus;
        statePayload = options.onPayload;
      }
      let closed = false;
      return {
        close() {
          closed = true;
        },
        closed: async () => undefined,
        start() {
          queueMicrotask(() => {
            if (!closed && !options.signal.aborted) options.onStatus('connected', null);
          });
        },
      };
    },
    async fetchCore() {
      coreReads += 1;
      if (coreReads === 1) {
        return new Promise<JsonHttpResponse>((resolve) => {
          releaseFirst = () => resolve(response(original));
        });
      }
      return response(reconnected);
    },
    async fetchJsonWithRetry() {
      throw new Error('detail HTTP is not used by watch');
    },
  };
  const watch = createFiveEPlayMatchSourceWithTransport({
    timing: { livePollMs: 60_000, reconnectInitialMs: 60_000 },
  }, transport).watch('csgo_mc_2395547');
  const iterator = watch[Symbol.asyncIterator]();
  await iterator.next();
  for (let attempt = 0; attempt < 50 && releaseFirst === null; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const emitPayload = statePayload as ((payload: unknown) => void) | null;
  const emitStatus = stateStatus as (
    (status: 'connected' | 'disconnected', error: unknown | null) => void
  ) | null;
  const release = releaseFirst as (() => void) | null;
  assert.ok(emitPayload);
  assert.ok(emitStatus);
  assert.ok(release);
  emitPayload({
    data: {
      from_ver: firstVersion,
      match: { bouts_state: [], mc_info: { id: 'csgo_mc_2395547' } },
      this_ver: `${BigInt(firstVersion) + 1n}`.padStart(firstVersion.length, '0'),
    },
    event_name: 'csgo-detail',
  });
  emitStatus('disconnected', new Error('fixture disconnect'));
  emitStatus('connected', null);
  assert.equal((await iterator.next()).value?.kind, 'blocked');
  assert.equal((await iterator.next()).value?.kind, 'blocked');
  release();

  const confirmed = await iterator.next();
  assert.equal(confirmed.value?.kind, 'confirmed-state');
  if (confirmed.value?.kind === 'confirmed-state') {
    assert.equal(confirmed.value.observation.freshness.stateVersion, reconnected.data.state_ver);
  }
  const staleReplay = await Promise.race([
    iterator.next(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 20)),
  ]);
  assert.equal(staleReplay, null);
  assert.equal(coreReads, 2);
  await watch[Symbol.asyncDispose]();
});

test('state MQTT invalidates an older in-flight HTTP terminal confirmation', async () => {
  const terminal = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-complete-three-maps.json', import.meta.url),
      'utf8',
    ),
  );
  const stateVersion = terminal.data.state_ver as string;
  let emitState: ((payload: unknown) => void) | null = null;
  let coreReads = 0;
  let releaseSecond: (() => void) | null = null;
  const ok = (): JsonHttpResponse => ({
    kind: 'ok',
    observedAt: Date.now() as JsonHttpResponse['observedAt'],
    payload: terminal,
    retryAfterMs: null,
    status: 200,
  });
  const transport: MatchTransport = {
    createRealtimeTopic(options) {
      const isState = options.topic.includes('/detail/');
      if (isState) emitState = options.onPayload;
      let closed = false;
      return {
        close() {
          closed = true;
        },
        closed: async () => undefined,
        start() {
          queueMicrotask(() => {
            if (!closed && !options.signal.aborted) options.onStatus('connected', null);
          });
        },
      };
    },
    async fetchCore() {
      coreReads += 1;
      if (coreReads === 1) return ok();
      if (coreReads === 2) {
        return new Promise<JsonHttpResponse>((resolve) => {
          releaseSecond = () => resolve(ok());
        });
      }
      return {
        kind: 'unavailable',
        observedAt: Date.now() as JsonHttpResponse['observedAt'],
        payload: null,
        retryAfterMs: null,
        status: 503,
      };
    },
    async fetchJsonWithRetry() {
      throw new Error('detail HTTP is not used by watch');
    },
  };
  const watch = createFiveEPlayMatchSourceWithTransport({
    timing: { closeCalibrationMs: 1, liveMaxAgeMs: 100, livePollMs: 10 },
  }, transport).watch('csgo_mc_2395547');
  const iterator = watch[Symbol.asyncIterator]();
  await iterator.next();
  const closing = await iterator.next();
  assert.equal(closing.value?.kind, 'confirmed-state');
  if (closing.value?.kind === 'confirmed-state') {
    assert.equal(closing.value.observation.state.lifecycle, 'closing');
  }
  for (let attempt = 0; attempt < 100 && releaseSecond === null; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  const emit = emitState as ((payload: unknown) => void) | null;
  const release = releaseSecond as (() => void) | null;
  assert.ok(emit);
  assert.ok(release);
  emit({
    data: {
      bouts_state: [],
      from_ver: stateVersion,
      match: { mc_info: { id: 'csgo_mc_2395547' } },
      this_ver: `${BigInt(stateVersion) + 1n}`.padStart(stateVersion.length, '0'),
    },
    event_name: 'csgo-detail',
  });
  const provisional = await iterator.next();
  assert.equal(provisional.value?.kind, 'provisional-telemetry');
  release();

  const afterInvalidation = await iterator.next();
  assert.equal(afterInvalidation.value?.kind, 'blocked');
  if (afterInvalidation.value?.kind === 'blocked') {
    assert.equal(afterInvalidation.value.reason, 'provider-unavailable');
  }
  assert.equal(watch.current()?.state.lifecycle, 'closing');
  assert.equal(coreReads, 3);
  await watch[Symbol.asyncDispose]();
});

test('watch publishes closing, calibrates closed, then completes automatically', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  const core = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-complete-three-maps.json', import.meta.url),
      'utf8',
    ),
  );
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) return Response.json(core);
    return new Response(null, { status: 404 });
  };
  const watch = createFiveEPlayMatchSource({
    timing: { closeCalibrationMs: 1, livePollMs: 1 },
  }).watch('csgo_mc_2395547');
  const iterator = watch[Symbol.asyncIterator]();
  await iterator.next();
  const closing = await iterator.next();
  assert.equal(closing.value?.kind, 'confirmed-state');
  if (closing.value?.kind === 'confirmed-state') {
    assert.equal(closing.value.observation.state.lifecycle, 'closing');
    assert.equal(closing.value.observation.state.dataFinality, 'provisional');
  }
  const closed = await iterator.next();
  assert.equal(closed.value?.kind, 'confirmed-state');
  if (closed.value?.kind === 'confirmed-state') {
    assert.equal(closed.value.observation.state.lifecycle, 'closed');
    assert.equal(closed.value.observation.state.dataFinality, 'stable');
  }
  assert.equal(watch.current()?.state.lifecycle, 'closed');
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test('watch requires two strictly consistent terminal provider versions before closed', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  const firstCore = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-complete-three-maps.json', import.meta.url),
      'utf8',
    ),
  );
  const correctedCore = structuredClone(firstCore);
  correctedCore.data.state_ver = `${BigInt(firstCore.data.state_ver) + 1n}`.padStart(
    firstCore.data.state_ver.length,
    '0',
  );
  let coreRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/data')) {
      coreRequests += 1;
      return Response.json(coreRequests === 1 ? firstCore : correctedCore);
    }
    return new Response(null, { status: 404 });
  };
  const watch = createFiveEPlayMatchSource({
    timing: { closeCalibrationMs: 1, livePollMs: 1 },
  }).watch('csgo_mc_2395547');
  context.after(async () => watch[Symbol.asyncDispose]());
  const iterator = watch[Symbol.asyncIterator]();
  await iterator.next();
  const first = await iterator.next();
  assert.equal(first.value?.kind, 'confirmed-state');
  if (first.value?.kind === 'confirmed-state') {
    assert.equal(first.value.observation.state.lifecycle, 'closing');
  }
  const corrected = await iterator.next();
  assert.equal(corrected.value?.kind, 'confirmed-state');
  if (corrected.value?.kind === 'confirmed-state') {
    assert.equal(corrected.value.observation.state.lifecycle, 'closing');
  }
  const closed = await iterator.next();
  assert.equal(closed.value?.kind, 'confirmed-state');
  if (closed.value?.kind === 'confirmed-state') {
    assert.equal(closed.value.observation.state.lifecycle, 'closed');
  }
});

test('an inconsistent HTTP sample breaks terminal closure continuity', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  const terminal = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-complete-three-maps.json', import.meta.url),
      'utf8',
    ),
  );
  const inconsistent = JSON.parse(
    await readFile(
      new URL('./fixtures/states/inconsistent-global-complete-map-live.json', import.meta.url),
      'utf8',
    ),
  );
  inconsistent.data.match.mc_info.id = 'csgo_mc_2395547';
  let coreRequests = 0;
  let releaseFourth: (() => void) | null = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/data')) {
      coreRequests += 1;
      if (coreRequests === 2) return Response.json(inconsistent);
      if (coreRequests >= 4) {
        return new Promise<Response>((resolve) => {
          releaseFourth = () => resolve(Response.json(terminal));
        });
      }
      return Response.json(terminal);
    }
    return new Response(null, { status: 404 });
  };
  const watch = createFiveEPlayMatchSource({
    timing: { closeCalibrationMs: 1, livePollMs: 1 },
  }).watch('csgo_mc_2395547');
  context.after(async () => watch[Symbol.asyncDispose]());
  const iterator = watch[Symbol.asyncIterator]();
  await iterator.next();
  const closing = await iterator.next();
  assert.equal(closing.value?.kind, 'confirmed-state');
  const inconsistentUpdate = await iterator.next();
  assert.equal(inconsistentUpdate.value?.kind, 'blocked');
  if (inconsistentUpdate.value?.kind === 'blocked') {
    assert.equal(inconsistentUpdate.value.reason, 'inconsistent-state');
  }
  const recovered = await iterator.next();
  assert.equal(recovered.value?.kind, 'confirmed-state');
  if (recovered.value?.kind === 'confirmed-state') {
    assert.equal(recovered.value.observation.state.lifecycle, 'closing');
  }
  for (let attempt = 0; attempt < 50 && releaseFourth === null; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(coreRequests, 4);
  assert.equal(watch.current()?.state.lifecycle, 'closing');
  const release = releaseFourth as (() => void) | null;
  assert.ok(release);
  release();
  const closed = await iterator.next();
  assert.equal(closed.value?.kind, 'confirmed-state');
  if (closed.value?.kind === 'confirmed-state') {
    assert.equal(closed.value.observation.state.lifecycle, 'closed');
  }
});

test('evidence sink failure is diagnostic-only and never blocks a snapshot', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const [core, firstPage, secondPage] = await Promise.all(
    [
      'states/bo3-between-map2-map3.json',
      'events/page-1.json',
      'events/page-2.json',
    ].map(async (name) =>
      JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')),
    ),
  );
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) return Response.json(core);
    if (url.pathname.endsWith('/match/csgo_mc_2395547/event/log')) {
      return Response.json(url.searchParams.get('update_version') === '0' ? firstPage : secondPage);
    }
    return new Response(null, { status: 404 });
  };
  const diagnostics: string[] = [];
  const result = await createFiveEPlayMatchSource({
    evidenceSink: () => {
      throw new Error('fixture sink failure');
    },
    limits: { eventPageSize: 6 },
    onDiagnostic: (event) => {
      diagnostics.push(event.code);
    },
  }).snapshot('csgo_mc_2395547');
  assert.equal(result.kind, 'confirmed');
  assert.ok(diagnostics.includes('EVIDENCE_SINK_FAILED'));
});

test('confirmed data is deeply frozen and contains no undefined or non-finite numbers', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const result = await snapshotFromFixture('bo3-between-map2-map3.json');
  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') return;

  const visit = (value: unknown, location: string): void => {
    assert.notEqual(value, undefined, `${location} must not be undefined`);
    if (typeof value === 'number') {
      assert.ok(Number.isFinite(value), `${location} must be finite`);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    assert.ok(Object.isFrozen(value), `${location} must be frozen`);
    for (const [key, child] of Object.entries(value)) visit(child, `${location}.${key}`);
  };
  visit(result.snapshot, 'snapshot');
});

test('a stable closed revision can be reused as an expected revision', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const body = await readFile(
    new URL('./fixtures/states/bo3-complete-three-maps.json', import.meta.url),
    'utf8',
  );
  globalThis.fetch = async () => new Response(body, { status: 200 });
  const source = createFiveEPlayMatchSource({
    timing: { closeCalibrationMs: 1, livePollMs: 1 },
  });
  const first = await source.snapshot('csgo_mc_2395547');
  assert.equal(first.kind, 'confirmed');
  if (first.kind !== 'confirmed') return;
  assert.equal(first.snapshot.state.lifecycle, 'closed');

  const second = await source.snapshot('csgo_mc_2395547', {
    expectedRevision: first.snapshot.revision,
  });
  assert.equal(second.kind, 'confirmed');
  if (second.kind === 'confirmed') {
    assert.equal(second.snapshot.revision, first.snapshot.revision);
  }
});

test('core HTTP retries retryable responses and respects Retry-After', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const core = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-between-map2-map3.json', import.meta.url),
      'utf8',
    ),
  );
  let coreRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) {
      coreRequests += 1;
      if (coreRequests === 1) {
        return new Response(null, {
          headers: { 'retry-after': '0' },
          status: 503,
        });
      }
      return Response.json(core);
    }
    return new Response(null, { status: 404 });
  };

  const result = await createFiveEPlayMatchSource().snapshot('csgo_mc_2395547');
  assert.equal(result.kind, 'confirmed');
  assert.equal(coreRequests, 3);
});

test('optional detail deadlines yield partial data without poisoning confirmed core state', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const core = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-between-map2-map3.json', import.meta.url),
      'utf8',
    ),
  );
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) return Response.json(core);
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };

  const result = await createFiveEPlayMatchSource({
    timing: { coreDeadlineMs: 100, detailDeadlineMs: 1, eventDeadlineMs: 1 },
  }).snapshot('csgo_mc_2395547', { deadlineMs: 100 });
  assert.equal(result.kind, 'confirmed');
  if (result.kind !== 'confirmed') return;
  assert.equal(result.snapshot.detailsCompleteness, 'partial');
  assert.equal(result.snapshot.details.analysis.status, 'unavailable');
  assert.equal(result.snapshot.details.events.status, 'unavailable');
  assert.equal(result.snapshot.details.teamRecentMatches.status, 'unavailable');
  assert.equal(result.snapshot.details.teamPastMatches.status, 'unavailable');
  assert.equal(result.snapshot.details.community.status, 'unavailable');
  assert.equal(result.snapshot.details.analysis.data, null);
  assert.equal(result.snapshot.details.events.data, null);
  assert.equal(result.snapshot.details.teamRecentMatches.data, null);
  assert.equal(result.snapshot.details.teamPastMatches.data, null);
  assert.equal(result.snapshot.details.community.data, null);
});

test('caller cancellation surfaces one typed ABORTED error', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const controller = new AbortController();
  controller.abort(new Error('fixture cancellation'));
  globalThis.fetch = async (_input, init) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    return new Response(null, { status: 500 });
  };

  await assert.rejects(
    createFiveEPlayMatchSource().snapshot('csgo_mc_2395547', {
      signal: controller.signal,
    }),
    (error) => error instanceof FiveEPlaySourceError && error.code === 'ABORTED',
  );
});

test('completed waits do not accumulate abort listeners', async () => {
  const controller = new AbortController();
  for (let index = 0; index < 20; index += 1) {
    await waitFor(1, controller.signal);
  }
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('bounded watch queue overflow notifies its resource owner', async () => {
  let overflow: unknown = null;
  const queue = new WatchQueue(1, (error) => {
    overflow = error;
  });
  queue.push({
    kind: 'not-found',
    matchId: 'csgo_mc_1',
  });
  queue.push({
    format: '1',
    kind: 'unsupported',
    matchId: 'csgo_mc_1',
    reason: 'format-unverified',
  });
  assert.ok(overflow instanceof FiveEPlaySourceError);
  assert.equal((await queue.next()).value?.kind, 'not-found');
  await assert.rejects(queue.next(), FiveEPlaySourceError);
});

test('watch terminates cleanly for not-found and unsupported matches', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  const bo1 = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-prestart.json', import.meta.url),
      'utf8',
    ),
  ) as { data: { match: { mc_info: { format: string; id: string } } } };
  bo1.data.match.mc_info.format = '1';
  let mode: 'not-found' | 'bo1' = 'not-found';
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/data')) {
      return mode === 'not-found' ? new Response(null, { status: 404 }) : Response.json(bo1);
    }
    return new Response(null, { status: 404 });
  };

  const missing = createFiveEPlayMatchSource().watch('csgo_mc_2395547');
  const missingIterator = missing[Symbol.asyncIterator]();
  assert.equal((await missingIterator.next()).value?.kind, 'blocked');
  assert.equal((await missingIterator.next()).value?.kind, 'not-found');
  assert.deepEqual(await missingIterator.next(), { done: true, value: undefined });

  mode = 'bo1';
  const unsupported = createFiveEPlayMatchSource().watch('csgo_mc_2395547');
  const unsupportedIterator = unsupported[Symbol.asyncIterator]();
  assert.equal((await unsupportedIterator.next()).value?.kind, 'blocked');
  const terminal = await unsupportedIterator.next();
  assert.equal(terminal.value?.kind, 'unsupported');
  if (terminal.value?.kind === 'unsupported') {
    assert.equal(terminal.value.reason, 'format-unverified');
  }
  assert.deepEqual(await unsupportedIterator.next(), { done: true, value: undefined });
});

test('watch retries an unavailable initial HTTP baseline instead of stalling', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  const core = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-live-map1-unopened.json', import.meta.url),
      'utf8',
    ),
  );
  let coreRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) {
      coreRequests += 1;
      if (coreRequests <= 6) {
        return new Response(null, {
          headers: { 'retry-after': '0' },
          status: 503,
        });
      }
      return Response.json(core);
    }
    return new Response(null, { status: 404 });
  };

  const watch = createFiveEPlayMatchSource({
    timing: { nearStartPollMs: 1, prestartPollMs: 1 },
  }).watch('csgo_mc_2395547');
  const iterator = watch[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, 'blocked');
  const unavailable = await iterator.next();
  assert.equal(unavailable.value?.kind, 'blocked');
  if (unavailable.value?.kind === 'blocked') {
    assert.equal(unavailable.value.reason, 'provider-unavailable');
  }
  const recovered = await iterator.next();
  assert.equal(recovered.value?.kind, 'confirmed-state');
  assert.ok(coreRequests >= 7);
  await watch[Symbol.asyncDispose]();
});

test('watch reports initial realtime credential failure instead of hanging at initializing', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore')) {
      return new Response(null, { status: 503 });
    }
    return new Response(null, { status: 404 });
  };
  const watch = createFiveEPlayMatchSource({
    timing: { reconnectInitialMs: 1 },
  }).watch('csgo_mc_2395547');
  context.after(async () => watch[Symbol.asyncDispose]());
  const iterator = watch[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, 'blocked');
  const unavailable = await iterator.next();
  assert.equal(unavailable.value?.kind, 'blocked');
  if (unavailable.value?.kind === 'blocked') {
    assert.equal(unavailable.value.reason, 'realtime-unavailable');
  }
});

test('watch rejects a failed MQTT SUBACK before starting its HTTP baseline', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.subackCode = 0x80;
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  let coreRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/data')) coreRequests += 1;
    return new Response(null, { status: 404 });
  };
  const watch = createFiveEPlayMatchSource({
    timing: { reconnectInitialMs: 60_000, realtimeHandshakeMs: 50 },
  }).watch('csgo_mc_2395547');
  context.after(async () => watch[Symbol.asyncDispose]());
  const iterator = watch[Symbol.asyncIterator]();
  await iterator.next();
  const unavailable = await iterator.next();
  assert.equal(unavailable.value?.kind, 'blocked');
  if (unavailable.value?.kind === 'blocked') {
    assert.equal(unavailable.value.reason, 'realtime-unavailable');
  }
  assert.equal(coreRequests, 0);
});

test('watch times out a missing MQTT SUBACK before starting its HTTP baseline', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.suppressSuback = true;
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  let coreRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/data')) coreRequests += 1;
    return new Response(null, { status: 404 });
  };
  const watch = createFiveEPlayMatchSource({
    timing: { reconnectInitialMs: 60_000, realtimeHandshakeMs: 5 },
  }).watch('csgo_mc_2395547');
  context.after(async () => watch[Symbol.asyncDispose]());
  const iterator = watch[Symbol.asyncIterator]();
  await iterator.next();
  const unavailable = await iterator.next();
  assert.equal(unavailable.value?.kind, 'blocked');
  if (unavailable.value?.kind === 'blocked') {
    assert.equal(unavailable.value.reason, 'realtime-unavailable');
  }
  assert.equal(coreRequests, 0);
});

test('closing an MQTT client aborts credential loading and permanently stops reconnects', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const caller = new AbortController();
  let credentialRequests = 0;
  let credentialAborts = 0;
  globalThis.fetch = async (_input, init) => {
    credentialRequests += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = (): void => {
        credentialAborts += 1;
        reject(signal?.reason);
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  };
  const client = new MqttTopicClient({
    onPayload: () => undefined,
    onStatus: () => undefined,
    reconnectInitialMs: 1,
    signal: caller.signal,
    topic: 'fixture/topic',
  });
  client.start();
  for (let attempt = 0; attempt < 20 && credentialRequests === 0; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  client.close();
  await client.closed();
  await new Promise<void>((resolve) => setTimeout(resolve, 5));

  assert.equal(credentialRequests, 1);
  assert.equal(credentialAborts, 1);
  assert.equal(caller.signal.aborted, false);
});

test('closing during an abort-insensitive credential request cannot create a socket', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  let announceCredentialStarted!: () => void;
  const credentialStarted = new Promise<void>((resolve) => {
    announceCredentialStarted = resolve;
  });
  let resolveCredentials!: (response: Response) => void;
  globalThis.fetch = async () => {
    announceCredentialStarted();
    return new Promise<Response>((resolve) => {
      resolveCredentials = resolve;
    });
  };
  const statuses: string[] = [];
  const client = new MqttTopicClient({
    onPayload: () => undefined,
    onStatus: (status) => statuses.push(status),
    reconnectInitialMs: 1,
    signal: new AbortController().signal,
    topic: 'fixture/topic',
  });
  client.start();
  await credentialStarted;

  client.close();
  resolveCredentials(Response.json({
    data: {
      client_id: 'fixture-client',
      password: 'fixture-password',
      username: 'fixture-user',
    },
    success: true,
  }));
  let settled = false;
  const closing = client.closed().then(() => {
    settled = true;
  });
  for (let attempt = 0; attempt < 10 && !settled; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const settledWithoutCleanup = settled;
  if (!settled) {
    broker.closeAll();
    await closing;
  }

  assert.equal(settledWithoutCleanup, true);
  assert.equal(broker.sockets.length, 0);
  assert.deepEqual(statuses, []);
});

test('aborting while a WebSocket is being created closes it before MQTT handshake', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  const caller = new AbortController();
  broker.onSocketCreated = () => caller.abort(new Error('fixture abort during construction'));
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  globalThis.fetch = async () => Response.json({
    data: {
      client_id: 'fixture-client',
      password: 'fixture-password',
      username: 'fixture-user',
    },
    success: true,
  });
  const statuses: string[] = [];
  const client = new MqttTopicClient({
    onPayload: () => undefined,
    onStatus: (status) => statuses.push(status),
    reconnectInitialMs: 1,
    signal: caller.signal,
    topic: 'fixture/topic',
  });
  client.start();

  let settled = false;
  const closing = client.closed().then(() => {
    settled = true;
  });
  for (let attempt = 0; attempt < 10 && !settled; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const settledWithoutCleanup = settled;
  if (!settled) {
    broker.closeAll();
    await closing;
  }

  assert.equal(settledWithoutCleanup, true);
  assert.equal(broker.sockets.length, 1);
  assert.equal(broker.sockets[0]?.readyState, 3);
  assert.deepEqual(statuses, []);
});

test('malformed subscribed MQTT traffic disconnects and blocks the watch', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  const core = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-live-map1-unopened.json', import.meta.url),
      'utf8',
    ),
  );
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/data')) return Response.json(core);
    return new Response(null, { status: 404 });
  };
  const watch = createFiveEPlayMatchSource({
    timing: { reconnectInitialMs: 60_000 },
  }).watch('csgo_mc_2395547');
  context.after(async () => watch[Symbol.asyncDispose]());
  const iterator = watch[Symbol.asyncIterator]();
  await iterator.next();
  assert.equal((await iterator.next()).value?.kind, 'confirmed-state');
  broker.publishMalformed('csgo/product/detail/csgo_mc_2395547');
  const unavailable = await iterator.next();
  assert.equal(unavailable.value?.kind, 'blocked');
  if (unavailable.value?.kind === 'blocked') {
    assert.equal(unavailable.value.reason, 'realtime-unavailable');
  }
});

test('watch treats an internal core timeout as retryable unavailability', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  const core = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-live-map1-unopened.json', import.meta.url),
      'utf8',
    ),
  );
  let coreRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) {
      coreRequests += 1;
      if (coreRequests === 1) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return Response.json(core);
    }
    return new Response(null, { status: 404 });
  };

  const watch = createFiveEPlayMatchSource({
    timing: { coreDeadlineMs: 5, nearStartPollMs: 1, prestartPollMs: 1 },
  }).watch('csgo_mc_2395547');
  const iterator = watch[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, 'blocked');
  const unavailable = await iterator.next();
  assert.equal(unavailable.value?.kind, 'blocked');
  if (unavailable.value?.kind === 'blocked') {
    assert.equal(unavailable.value.reason, 'provider-unavailable');
  }
  assert.equal((await iterator.next()).value?.kind, 'confirmed-state');
  await watch[Symbol.asyncDispose]();
});

test('watch distinguishes stale confirmed HTTP data from a fresh provider failure', async (context) => {
  const originalFetch = globalThis.fetch;
  const broker = new FakeMqttBroker();
  broker.install();
  context.after(() => {
    globalThis.fetch = originalFetch;
    broker.restore();
  });
  const core = JSON.parse(
    await readFile(
      new URL('./fixtures/states/bo3-live-map1-unopened.json', import.meta.url),
      'utf8',
    ),
  );
  let coreRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/restrict/matchscore') && init?.method === 'POST') {
      return Response.json({
        data: { client_id: 'fixture-client', password: 'fixture-password', username: 'fixture-user' },
        success: true,
      });
    }
    if (url.pathname.endsWith('/matches/csgo_mc_2395547/data')) {
      coreRequests += 1;
      if (coreRequests === 1) return Response.json(core);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(null, { headers: { 'retry-after': '0' }, status: 503 });
    }
    return new Response(null, { status: 404 });
  };

  const watch = createFiveEPlayMatchSource({
    timing: {
      coreDeadlineMs: 100,
      liveMaxAgeMs: 3,
      livePollMs: 1,
      nearStartPollMs: 1,
      prestartPollMs: 1,
    },
  }).watch('csgo_mc_2395547');
  const iterator = watch[Symbol.asyncIterator]();
  await iterator.next();
  assert.equal((await iterator.next()).value?.kind, 'confirmed-state');
  const stale = await iterator.next();
  assert.equal(stale.value?.kind, 'blocked');
  if (stale.value?.kind === 'blocked') assert.equal(stale.value.reason, 'stale-http');
  assert.ok(watch.current());
  await watch[Symbol.asyncDispose]();
});
