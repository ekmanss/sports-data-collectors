import { AsyncQueue } from './async_queue.js';
import { captureFiveEPlayMatch, type CapturedFiveEPlayMatch } from './capture.js';
import { FiveEPlayError } from './errors.js';
import { transformLogRecord } from './log.js';
import { MqttTopicConnection } from './mqtt.js';
import { buildFiveEPlayMatch, mergeDetailData } from './transform.js';
import type {
  CreateFiveEPlayMatchSessionOptions,
  FiveEPlayMatch,
  FiveEPlayMatchSession,
  FiveEPlayProgressEvent,
  FiveEPlayRealtimeUpdate,
} from './types.js';
import { record, text } from './value.js';

class FiveEPlayMatchSessionImpl implements FiveEPlayMatchSession {
  readonly id: string;
  readonly initial: CapturedFiveEPlayMatch['result'];
  readonly #capture: CapturedFiveEPlayMatch;
  readonly #controller: AbortController;
  readonly #queue = new AsyncQueue<FiveEPlayRealtimeUpdate>();
  readonly #connections: MqttTopicConnection[] = [];
  readonly #externalSignal: AbortSignal | undefined;
  readonly #onExternalAbort: () => void;
  #current: FiveEPlayMatch;
  #closed = false;

  constructor(capture: CapturedFiveEPlayMatch, controller: AbortController, externalSignal?: AbortSignal) {
    this.id = capture.identity.id;
    this.initial = capture.result;
    this.#capture = capture;
    this.#controller = controller;
    this.#externalSignal = externalSignal;
    this.#current = capture.result.data;
    this.#onExternalAbort = () => { void this.close(); };
    externalSignal?.addEventListener('abort', this.#onExternalAbort, { once: true });
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
    this.#capture.detailData = mergeDetailData(this.#capture.detailData, data);
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
      type: 'state',
      capturedAt,
      stateVersion: this.#current.stateVersion,
      snapshot: structuredClone(this.#current),
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
    if (this.#closed) return;
    this.#closed = true;
    this.#externalSignal?.removeEventListener('abort', this.#onExternalAbort);
    this.#controller.abort(new FiveEPlayError('5EPlay realtime session was closed', {
      code: 'SESSION_CLOSED', operation: 'match-realtime',
      stage: 'streaming-realtime', retryable: false, matchId: this.id,
    }));
    for (const connection of this.#connections) connection.close();
    this.#queue.close();
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
  const session = new FiveEPlayMatchSessionImpl(capture, controller, options.signal);
  const fetchImpl = options.fetch ?? globalThis.fetch;
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
