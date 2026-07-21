import { fetchCore, fetchJsonWithRetry } from './http.js';
import { MqttTopicClient, type MqttTopicClientOptions } from './mqtt.js';
import type { MatchTransport } from './port.js';

export const productionTransport: MatchTransport = Object.freeze({
  createRealtimeTopic: (options: MqttTopicClientOptions) => new MqttTopicClient(options),
  fetchCore,
  fetchJsonWithRetry,
});
