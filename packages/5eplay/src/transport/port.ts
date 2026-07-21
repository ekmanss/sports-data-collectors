import type { MqttTopicClientOptions } from './mqtt.js';
import type { AttemptedJsonHttpResponse, JsonHttpResponse } from './http.js';

export interface RealtimeTopic {
  start(): void;
  close(): void;
  closed(): Promise<void>;
}

export interface MatchTransport {
  fetchCore(matchId: string, signal: AbortSignal): Promise<JsonHttpResponse>;
  fetchJsonWithRetry(
    url: string,
    signal: AbortSignal,
    maximumAttempts?: number,
  ): Promise<AttemptedJsonHttpResponse>;
  createRealtimeTopic(options: MqttTopicClientOptions): RealtimeTopic;
}
