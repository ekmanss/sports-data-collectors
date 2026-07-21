import { createHash } from 'node:crypto';
import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { asRecord, asString } from '../src/internal/value.js';
import { ESPORTS_DATA_BASE_URL } from '../src/transport/http.js';
import { MqttTopicClient } from '../src/transport/mqtt.js';

interface Arguments {
  readonly matchId: string;
  readonly outputDirectory: string;
  readonly durationMs: number;
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm --filter @ekmanss/5eplay record -- --match-id csgo_mc_123 --out-dir /absolute/new-directory [--duration-ms 1800000]',
    '',
    'The output directory must be new, its parent must exist, and it must resolve outside this Git repository.',
    'Credentials remain in memory.',
  ].join('\n');
}

function argumentsFromCommandLine(values: readonly string[]): Arguments {
  const valueFor = (flag: string): string | null => {
    const index = values.indexOf(flag);
    return index < 0 ? null : values[index + 1] ?? null;
  };
  const matchId = valueFor('--match-id') ?? '';
  const outputDirectory = valueFor('--out-dir') ?? '';
  const durationMs = Number(valueFor('--duration-ms') ?? 1_800_000);
  if (!/^csgo_mc_[1-9]\d*$/.test(matchId)) throw new Error(`invalid --match-id\n${usage()}`);
  if (!isAbsolute(outputDirectory)) throw new Error(`--out-dir must be absolute\n${usage()}`);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 86_400_000) {
    throw new Error('--duration-ms must be between 1 and 86400000');
  }
  const repositoryRoot = resolve(import.meta.dirname, '../../..');
  if (isInside(repositoryRoot, resolve(outputDirectory))) {
    throw new Error('--out-dir must be outside the Git repository');
  }
  return { durationMs, matchId, outputDirectory };
}

function isInside(parent: string, candidate: string): boolean {
  const parentRelative = relative(parent, candidate);
  return (
    parentRelative === ''
    || (!parentRelative.startsWith('..') && !isAbsolute(parentRelative))
  );
}

async function createOutputDirectory(requestedPath: string): Promise<string> {
  const repositoryRealPath = await realpath(resolve(import.meta.dirname, '../../..'));
  const requested = resolve(requestedPath);
  const parentRealPath = await realpath(dirname(requested));
  const candidate = resolve(parentRealPath, basename(requested));
  if (isInside(repositoryRealPath, candidate)) {
    throw new Error('--out-dir parent resolves through a symbolic link into the Git repository');
  }
  await mkdir(candidate, { mode: 0o700, recursive: false });
  const outputRealPath = await realpath(candidate);
  if (isInside(repositoryRealPath, outputRealPath)) {
    throw new Error('--out-dir resolves through a symbolic link into the Git repository');
  }
  return outputRealPath;
}

class JsonLineWriter {
  readonly #handle: FileHandle;
  readonly #onFailure: (error: unknown) => void;
  readonly #maximumQueuedLines: number;
  readonly #queue: string[] = [];
  #draining: Promise<void> | null = null;
  #failure: unknown | null = null;
  #closed = false;

  constructor(
    handle: FileHandle,
    onFailure: (error: unknown) => void,
    maximumQueuedLines = 4_096,
  ) {
    this.#handle = handle;
    this.#onFailure = onFailure;
    this.#maximumQueuedLines = maximumQueuedLines;
  }

  get failure(): unknown | null {
    return this.#failure;
  }

  append(value: unknown): void {
    if (this.#failure !== null) return;
    if (this.#closed) {
      this.#fail(new Error('attempted to write after recorder output was closed'));
      return;
    }
    if (this.#queue.length >= this.#maximumQueuedLines) {
      this.#fail(new Error('recorder output queue exceeded its safety bound'));
      return;
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      this.#fail(new TypeError('recorder output is not JSON-serializable'));
      return;
    }
    this.#queue.push(`${encoded}\n`);
    this.#startDrain();
  }

  async close(): Promise<void> {
    this.#closed = true;
    while (this.#draining !== null) await this.#draining;
    await this.#handle.close();
    if (this.#failure !== null) throw this.#failure;
  }

  #startDrain(): void {
    if (this.#draining !== null || this.#failure !== null) return;
    this.#draining = this.#drain();
  }

  async #drain(): Promise<void> {
    try {
      while (this.#queue.length > 0 && this.#failure === null) {
        const line = this.#queue.shift();
        if (line !== undefined) await this.#handle.appendFile(line, 'utf8');
      }
    } catch (error) {
      this.#fail(error);
    } finally {
      this.#draining = null;
      if (this.#queue.length > 0 && this.#failure === null) this.#startDrain();
    }
  }

  #fail(error: unknown): void {
    if (this.#failure !== null) return;
    this.#failure = error;
    this.#queue.length = 0;
    this.#onFailure(error);
  }
}

const arguments_ = argumentsFromCommandLine(process.argv.slice(2));
const outputDirectory = await createOutputDirectory(arguments_.outputDirectory);
const mqttPath = resolve(outputDirectory, 'mqtt.jsonl');
const httpIndexPath = resolve(outputDirectory, 'http-index.jsonl');
const mqttHandle = await open(mqttPath, 'wx', 0o600);
let httpIndexHandle: FileHandle;
try {
  httpIndexHandle = await open(httpIndexPath, 'wx', 0o600);
} catch (error) {
  await mqttHandle.close();
  throw error;
}

const controller = new AbortController();
const abortForOutputFailure = (error: unknown): void => controller.abort(error);
const mqttWriter = new JsonLineWriter(mqttHandle, abortForOutputFailure);
const httpIndexWriter = new JsonLineWriter(httpIndexHandle, abortForOutputFailure);
const stop = (): void => controller.abort(new Error('recording stopped'));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const timer = setTimeout(stop, arguments_.durationMs);

async function recordJson(label: string, url: string): Promise<unknown> {
  const capturedAt = new Date().toISOString();
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: controller.signal,
  });
  const text = await response.text();
  const payload = text === '' ? null : (JSON.parse(text) as unknown);
  const filename = `${capturedAt.replaceAll(':', '-')}-${label}.json`;
  await writeFile(resolve(outputDirectory, filename), text, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  httpIndexWriter.append({
    capturedAt,
    contentType: response.headers.get('content-type'),
    filename,
    label,
    sha256: createHash('sha256').update(text).digest('hex'),
    status: response.status,
    url,
  });
  return payload;
}

const stateTopic = `csgo/product/detail/${arguments_.matchId}`;
const eventTopic = `csgo/product/event/log/${arguments_.matchId}`;
const clients = [stateTopic, eventTopic].map(
  (topic) =>
    new MqttTopicClient({
      onPayload: (payload) =>
        mqttWriter.append({ capturedAt: new Date().toISOString(), payload, topic }),
      onStatus: (status, error) =>
        mqttWriter.append({
          capturedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : error === null ? null : String(error),
          status,
          topic,
        }),
      signal: controller.signal,
      topic,
    }),
);
for (const client of clients) client.start();

let operationError: unknown | null = null;
try {
  const coreUrl = `${ESPORTS_DATA_BASE_URL}/matches/${arguments_.matchId}/data`;
  const initial = asRecord(await recordJson('data-initial', coreUrl), 'initial response');
  const data = asRecord(initial.data, 'initial response.data');
  const match = asRecord(data.match, 'initial response.data.match');
  const info = asRecord(match.mc_info, 'initial response match.mc_info');
  if (asString(info.id, 'initial response match.mc_info.id') !== arguments_.matchId) {
    throw new Error('initial response match identity mismatch');
  }
  const teamIds = [
    asString(asRecord(info.t1_info, 't1_info').id, 't1_info.id'),
    asString(asRecord(info.t2_info, 't2_info').id, 't2_info.id'),
  ];
  await Promise.all([
    recordJson(
      'analysis',
      `${ESPORTS_DATA_BASE_URL}/matches/${arguments_.matchId}/analysis_v1`,
    ),
    recordJson(
      'events',
      `${ESPORTS_DATA_BASE_URL}/match/${arguments_.matchId}/event/log?update_version=0&limit=500`,
    ),
    ...teamIds.flatMap((teamId, index) => [
      recordJson(
        `team-${index + 1}-header-history`,
        `${ESPORTS_DATA_BASE_URL}/teams/${teamId}/matches?page=1&limit=20`,
      ),
      recordJson(
        `team-${index + 1}-analysis-history`,
        `${ESPORTS_DATA_BASE_URL}/team/matches_v1/${teamId}?page=1&limit=30&status=past`,
      ),
    ]),
    recordJson(
      'community-tabs',
      `https://app.5eplay.com/api/score/match_score_tab?match_id=${arguments_.matchId}&game_type=1`,
    ),
  ]);

  while (!controller.signal.aborted) {
    await delay(5_000, undefined, { signal: controller.signal });
    await recordJson('data-poll', coreUrl);
  }
} catch (error) {
  if (!controller.signal.aborted) operationError = error;
} finally {
  clearTimeout(timer);
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  if (!controller.signal.aborted) controller.abort(new Error('recorder finished'));
  for (const client of clients) client.close();
  await Promise.all(clients.map((client) => client.closed()));
  const writerResults = await Promise.allSettled([
    mqttWriter.close(),
    httpIndexWriter.close(),
  ]);
  for (const result of writerResults) {
    if (result.status === 'rejected' && operationError === null) operationError = result.reason;
  }
}

operationError ??= mqttWriter.failure ?? httpIndexWriter.failure;
if (operationError !== null) throw operationError;
