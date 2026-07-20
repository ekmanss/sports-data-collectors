import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { MqttTopicConnection } from '../packages/5eplay/src/mqtt.js';

const matchId = process.argv[2] ?? 'csgo_mc_2395918';
const root = new URL(`./evidence/observations/${matchId}/`, import.meta.url);
const dataUrl = `https://esports-data.5eplaycdn.com/v1/api/csgo/matches/${matchId}/data`;
const controller = new AbortController();
let sequence = 0;
let previousHttpHash = '';
let pollInFlight = false;

function stamp(): string {
  return new Date().toISOString();
}

function safeStamp(value: string): string {
  return value.replaceAll(':', '-').replaceAll('.', '-');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stateSummary(envelope: unknown): unknown {
  const data = asRecord(asRecord(envelope).data);
  const match = asRecord(data.match);
  const global = asRecord(match.global_state);
  const bouts = Array.isArray(match.bouts_state) ? match.bouts_state : [];
  return {
    stateVersion: data.state_ver ?? null,
    global: {
      status: global.status ?? null,
      liveStatus: global.live_status ?? null,
      team1Score: global.t1_score ?? null,
      team2Score: global.t2_score ?? null,
      team1QuickScore: global.t1_quick_score ?? null,
      team2QuickScore: global.t2_quick_score ?? null,
      logText: global.log_text ?? null,
    },
    bouts: bouts.map((value) => {
      const bout = asRecord(value);
      const team1 = asRecord(bout.t1_stats);
      const team2 = asRecord(bout.t2_stats);
      return {
        number: bout.bout_num ?? null,
        map: bout.map_name ?? null,
        status: bout.status ?? null,
        display: bout.display ?? null,
        result: bout.result ?? null,
        startedAt: bout.start_time ?? null,
        endedAt: bout.end_time ?? null,
        currentRound: bout.curr_round_num ?? null,
        roundStage: bout.curr_bout_stage ?? null,
        team1Score: team1.all_score ?? null,
        team2Score: team2.all_score ?? null,
      };
    }),
  };
}

async function recordIndex(value: unknown): Promise<void> {
  await appendFile(new URL('index.jsonl', root), `${JSON.stringify(value)}\n`);
}

async function saveHttpSnapshot(reason: string): Promise<Record<string, unknown>> {
  const response = await fetch(dataUrl, { signal: controller.signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${dataUrl}`);
  const body = await response.text();
  const hash = createHash('sha256').update(body).digest('hex');
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (hash !== previousHttpHash) {
    previousHttpHash = hash;
    const capturedAt = stamp();
    const file = `http-${safeStamp(capturedAt)}-${hash.slice(0, 12)}.json`;
    await writeFile(new URL(file, root), body);
    const entry = {
      sequence: ++sequence,
      capturedAt,
      source: 'http',
      reason,
      sha256: hash,
      file,
      summary: stateSummary(parsed),
    };
    await recordIndex(entry);
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
  return parsed;
}

async function poll(): Promise<void> {
  if (pollInFlight || controller.signal.aborted) return;
  pollInFlight = true;
  try {
    await saveHttpSnapshot('poll');
  } catch (error) {
    if (!controller.signal.aborted) {
      const entry = {
        sequence: ++sequence,
        capturedAt: stamp(),
        source: 'observer-error',
        operation: 'http-poll',
        error: error instanceof Error ? error.message : String(error),
      };
      await recordIndex(entry);
      process.stderr.write(`${JSON.stringify(entry)}\n`);
    }
  } finally {
    pollInFlight = false;
  }
}

await mkdir(root, { recursive: true });
const initial = await saveHttpSnapshot('initial');
const initialData = asRecord(asRecord(initial).data);
const realtimeTopic = initialData.eplus_realtime_topic;
const topics = [
  `csgo/product/detail/${matchId}`,
  `csgo/product/event/log/${matchId}`,
  ...(typeof realtimeTopic === 'string' && realtimeTopic ? [realtimeTopic] : []),
];

const connections = topics.map((topic) => new MqttTopicConnection({
  topic,
  fetch,
  signal: controller.signal,
  onPayload(payload) {
    const capturedAt = stamp();
    const entry = {
      sequence: ++sequence,
      capturedAt,
      source: 'mqtt',
      topic,
      payload,
    };
    void appendFile(new URL('mqtt.jsonl', root), `${JSON.stringify(entry)}\n`)
      .then(() => recordIndex({
        sequence: entry.sequence,
        capturedAt,
        source: 'mqtt',
        topic,
        eventName: asRecord(payload).event_name ?? null,
      }))
      .then(() => process.stdout.write(`${JSON.stringify({
        sequence: entry.sequence,
        capturedAt,
        source: 'mqtt',
        topic,
        eventName: asRecord(payload).event_name ?? null,
      })}\n`))
      .catch((error) => process.stderr.write(`${String(error)}\n`));
  },
}));

await Promise.all(connections.map((connection) => connection.start()));
process.stdout.write(`${JSON.stringify({ capturedAt: stamp(), source: 'observer-ready', topics })}\n`);

const timer = setInterval(() => { void poll(); }, 5_000);
const stop = async (): Promise<void> => {
  clearInterval(timer);
  controller.abort(new Error('observer stopped'));
  for (const connection of connections) connection.close();
  while (pollInFlight) await new Promise((resolve) => setTimeout(resolve, 25));
};

process.once('SIGINT', () => { void stop().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)); });
