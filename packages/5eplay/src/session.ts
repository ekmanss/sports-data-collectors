import { AsyncQueue } from './async_queue.js';
import { captureFiveEPlayMatch, type CapturedFiveEPlayMatch } from './capture.js';
import { asFiveEPlayError, FiveEPlayError } from './errors.js';
import { transformLogRecord } from './log.js';
import { MqttTopicConnection } from './mqtt.js';
import { buildFiveEPlayMatch, mergeDetailData } from './transform.js';
import type {
  CreateFiveEPlayMatchSessionOptions,
  FiveEPlayMap,
  FiveEPlayMatch,
  FiveEPlayMatchSession,
  FiveEPlayProgressEvent,
  FiveEPlayRealtimeUpdate,
} from './types.js';
import { record, text } from './value.js';

function matchingTeam(map: FiveEPlayMap, teamId: string | null, index: number) {
  return teamId === null
    ? map.teams[index]
    : map.teams.find((team) => team.teamId === teamId);
}

function realtimeProgressRegressed(previous: FiveEPlayMatch, next: FiveEPlayMatch): boolean {
  for (const previousMap of previous.maps) {
    const nextMap = next.maps.find((map) => map.number === previousMap.number);
    if (!nextMap) return true;
    if (previousMap.status === 'completed' && nextMap.status !== 'completed') return true;
    if (previousMap.status === 'live' && !['live', 'completed'].includes(nextMap.status)) return true;
    for (const [index, previousTeam] of previousMap.teams.entries()) {
      if (previousTeam.score === null) continue;
      const nextScore = matchingTeam(nextMap, previousTeam.teamId, index)?.score;
      if (nextScore === null || nextScore === undefined || nextScore < previousTeam.score) return true;
    }
  }
  return false;
}

class FiveEPlayMatchSessionImpl implements FiveEPlayMatchSession {
  readonly id: string;
  readonly initial: CapturedFiveEPlayMatch['result'];
  readonly #capture: CapturedFiveEPlayMatch;
  readonly #controller: AbortController;
  readonly #queue = new AsyncQueue<FiveEPlayRealtimeUpdate>();
  readonly #connections: MqttTopicConnection[] = [];
  readonly #externalSignal: AbortSignal | undefined;
  readonly #onExternalAbort: () => void;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #onProgress: CreateFiveEPlayMatchSessionOptions['onProgress'];
  #current: FiveEPlayMatch;
  #closed = false;
  #recoveringFromRegression = false;
  #resyncing: Promise<void> | null = null;

  constructor(
    capture: CapturedFiveEPlayMatch,
    controller: AbortController,
    fetchImpl: typeof globalThis.fetch,
    options: CreateFiveEPlayMatchSessionOptions,
  ) {
    this.id = capture.identity.id;
    this.initial = capture.result;
    this.#capture = capture;
    this.#controller = controller;
    this.#fetch = fetchImpl;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#onProgress = options.onProgress;
    this.#externalSignal = options.signal;
    this.#current = capture.result.data;
    this.#onExternalAbort = () => { void this.close(); };
    options.signal?.addEventListener('abort', this.#onExternalAbort, { once: true });
    this.#queue.push({
      type: 'snapshot',
      capturedAt: this.#current.capturedAt,
      snapshot: structuredClone(this.#current),
    });
  }

  addConnection(connection: MqttTopicConnection): void {
    this.#connections.push(connection);
  }

  snapshot(): FiveEPlayMatch {
    if (this.#closed) {
      throw new FiveEPlayError('5EPlay realtime session is closed', {
        code: 'SESSION_CLOSED', operation: 'match-realtime',
        stage: 'streaming-realtime', retryable: false, matchId: this.id,
      });
    }
    return structuredClone(this.#current);
  }

  handleState(payload: unknown): void {
    if (this.#closed) return;
    const root = record(payload);
    if (text(root.event_name) !== 'csgo-detail') return;
    const data = record(root.data);
    const detailData = mergeDetailData(this.#capture.detailData, data);
    const capturedAt = new Date().toISOString();
    const next = buildFiveEPlayMatch({
      identity: this.#capture.identity,
      capturedAt,
      detailData,
      analysisData: this.#capture.analysisData,
      logs: this.#capture.logs,
      community: this.#capture.community,
    });
    if (realtimeProgressRegressed(this.#current, next)) {
      if (!this.#recoveringFromRegression) this.#startResync();
      return;
    }
    this.#recoveringFromRegression = false;
    this.#capture.detailData = detailData;
    this.#current = next;
    this.#queue.push({
      type: 'state',
      capturedAt,
      stateVersion: this.#current.stateVersion,
      snapshot: structuredClone(this.#current),
    });
  }

  #startResync(): void {
    if (this.#closed || this.#resyncing !== null) return;
    this.#recoveringFromRegression = true;
    this.#onProgress?.({
      operation: 'match-realtime',
      stage: 'streaming-realtime',
      message: 'Realtime map progress regressed; resyncing the authoritative HTTP snapshot',
      timestamp: new Date().toISOString(),
    });
    const trusted = this.#current;
    this.#resyncing = this.#resyncFromHttp(trusted)
      .catch((error) => this.#fail(error))
      .finally(() => { this.#resyncing = null; });
  }

  async #resyncFromHttp(trusted: FiveEPlayMatch): Promise<void> {
    const refreshed = await captureFiveEPlayMatch(
      this.id,
      { fetch: this.#fetch },
      {
        timeoutMs: this.#timeoutMs,
        signal: this.#controller.signal,
        includeAnalysis: false,
        includeCommunityRatings: false,
        includeLogs: false,
      },
    );
    if (this.#closed) return;
    const capturedAt = refreshed.result.data.capturedAt;
    const next = buildFiveEPlayMatch({
      identity: this.#capture.identity,
      capturedAt,
      detailData: refreshed.detailData,
      analysisData: this.#capture.analysisData,
      logs: this.#capture.logs,
      community: this.#capture.community,
    });
    if (!this.#recoveringFromRegression && realtimeProgressRegressed(this.#current, next)) return;
    const rollbackConfirmed = realtimeProgressRegressed(trusted, next);
    this.#capture.detailData = refreshed.detailData;
    this.#current = next;
    this.#recoveringFromRegression = !rollbackConfirmed;
    this.#queue.push({
      type: 'state',
      capturedAt,
      stateVersion: next.stateVersion,
      snapshot: structuredClone(next),
    });
    this.#onProgress?.({
      operation: 'match-realtime',
      stage: 'streaming-realtime',
      message: rollbackConfirmed
        ? 'Authoritative HTTP snapshot confirmed the map rollback'
        : 'Authoritative HTTP snapshot rejected the transient map rollback',
      timestamp: new Date().toISOString(),
    });
  }

  handleLog(payload: unknown): void {
    if (this.#closed) return;
    const root = record(payload);
    if (text(root.event_name) !== 'csgo-event-log') return;
    const data = record(root.data);
    const info = record(data.info);
    const event = transformLogRecord(info);
    if (!event.mapNumber) return;
    const existing = this.#capture.logs.get(event.mapNumber) ?? {
      complete: false,
      fromVersion: text(data.from_ver),
      toVersion: null,
      rows: [],
    };
    existing.rows.push(info);
    existing.toVersion = text(data.to_ver) ?? existing.toVersion;
    this.#capture.logs.set(event.mapNumber, existing);
    const capturedAt = new Date().toISOString();
    this.#current = buildFiveEPlayMatch({
      identity: this.#capture.identity,
      capturedAt,
      detailData: this.#capture.detailData,
      analysisData: this.#capture.analysisData,
      logs: this.#capture.logs,
      community: this.#capture.community,
    });
    this.#queue.push({
      type: 'log',
      capturedAt,
      event,
      snapshot: structuredClone(this.#current),
    });
  }

  async close(): Promise<void> {
    this.#finish(new FiveEPlayError('5EPlay realtime session was closed', {
      code: 'SESSION_CLOSED', operation: 'match-realtime',
      stage: 'streaming-realtime', retryable: false, matchId: this.id,
    }), false);
  }

  #fail(error: unknown): void {
    this.#finish(asFiveEPlayError(error, {
      code: 'REALTIME_CONNECTION_FAILED', operation: 'match-realtime',
      stage: 'streaming-realtime', retryable: true, matchId: this.id,
    }), true);
  }

  #finish(reason: FiveEPlayError, rejectQueue: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#externalSignal?.removeEventListener('abort', this.#onExternalAbort);
    this.#controller.abort(reason);
    for (const connection of this.#connections) connection.close();
    this.#queue.close(rejectQueue ? reason : undefined);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<FiveEPlayRealtimeUpdate> {
    return this.#queue[Symbol.asyncIterator]();
  }
}

function emit(
  options: CreateFiveEPlayMatchSessionOptions,
  stage: FiveEPlayProgressEvent['stage'],
  message: string,
): void {
  options.onProgress?.({
    operation: 'match-realtime',
    stage,
    message,
    timestamp: new Date().toISOString(),
  });
}

export async function createFiveEPlayMatchSession(
  input: string,
  options: CreateFiveEPlayMatchSessionOptions = {},
): Promise<FiveEPlayMatchSession> {
  const capture = await captureFiveEPlayMatch(input, options, options);
  const controller = new AbortController();
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const session = new FiveEPlayMatchSessionImpl(capture, controller, fetchImpl, options);
  const stateTopic = `csgo/product/detail/${capture.identity.id}`;
  const logTopic = `csgo/product/event/log/${capture.identity.id}`;
  const state = new MqttTopicConnection({
    topic: stateTopic,
    fetch: fetchImpl,
    signal: controller.signal,
    webSocketFactory: options.webSocketFactory,
    onPayload: (payload) => session.handleState(payload),
  });
  const log = new MqttTopicConnection({
    topic: logTopic,
    fetch: fetchImpl,
    signal: controller.signal,
    webSocketFactory: options.webSocketFactory,
    onPayload: (payload) => session.handleLog(payload),
  });
  session.addConnection(state);
  session.addConnection(log);
  emit(options, 'connecting-realtime', 'Connecting 5EPlay score and event topics');
  try {
    await Promise.all([state.start(), log.start()]);
  } catch (error) {
    await session.close();
    throw error;
  }
  emit(options, 'streaming-realtime', '5EPlay realtime session connected');
  return session;
}
