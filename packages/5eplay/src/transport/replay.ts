import type { MqttTopicClientOptions } from './mqtt.js';
import type { MatchTransport, RealtimeTopic } from './port.js';
import type { AttemptedJsonHttpResponse, JsonHttpResponse } from './http.js';
import { unixMilliseconds } from '../internal/value.js';

export interface ReplayHttpFrame {
  readonly urlIncludes: string;
  readonly kind: JsonHttpResponse['kind'];
  readonly status: number;
  readonly payload: unknown;
}

export interface ReplayRealtimeFrame {
  readonly topic: string;
  readonly payload: unknown;
}

class ReplayTopic implements RealtimeTopic {
  readonly #options: MqttTopicClientOptions;
  readonly #frames: readonly ReplayRealtimeFrame[];
  #closed = false;

  constructor(options: MqttTopicClientOptions, frames: readonly ReplayRealtimeFrame[]) {
    this.#options = options;
    this.#frames = frames;
  }

  start(): void {
    queueMicrotask(() => {
      if (this.#closed || this.#options.signal.aborted) return;
      this.#options.onStatus('connected', null);
      for (const frame of this.#frames) {
        if (frame.topic === this.#options.topic) this.#options.onPayload(frame.payload);
      }
    });
  }

  close(): void {
    this.#closed = true;
  }

  closed(): Promise<void> {
    return Promise.resolve();
  }
}

export class ReplayTransport implements MatchTransport {
  readonly #httpFrames: ReplayHttpFrame[];
  readonly #realtimeFrames: readonly ReplayRealtimeFrame[];

  constructor(
    httpFrames: readonly ReplayHttpFrame[],
    realtimeFrames: readonly ReplayRealtimeFrame[] = [],
  ) {
    this.#httpFrames = [...httpFrames];
    this.#realtimeFrames = realtimeFrames;
  }

  async fetchCore(matchId: string, signal: AbortSignal): Promise<JsonHttpResponse> {
    return this.#response(`/matches/${matchId}/data`, signal);
  }

  async fetchJsonWithRetry(
    url: string,
    signal: AbortSignal,
    _maximumAttempts = 3,
  ): Promise<AttemptedJsonHttpResponse> {
    return { ...(await this.#response(url, signal)), attempts: 1 };
  }

  createRealtimeTopic(options: MqttTopicClientOptions): RealtimeTopic {
    return new ReplayTopic(options, this.#realtimeFrames);
  }

  #response(url: string, signal: AbortSignal): JsonHttpResponse {
    if (signal.aborted) throw signal.reason;
    const index = this.#httpFrames.findIndex((frame) => url.includes(frame.urlIncludes));
    const frame = index < 0 ? undefined : this.#httpFrames.splice(index, 1)[0];
    if (frame === undefined) {
      return {
        kind: 'not-found',
        observedAt: unixMilliseconds(),
        payload: null,
        retryAfterMs: null,
        status: 404,
      };
    }
    return {
      kind: frame.kind,
      observedAt: unixMilliseconds(),
      payload: frame.payload,
      retryAfterMs: null,
      status: frame.status,
    };
  }
}
