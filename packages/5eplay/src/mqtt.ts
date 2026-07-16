import { FiveEPlayError } from './errors.js';
import type {
  FiveEPlayWebSocketFactory,
  FiveEPlayWebSocketLike,
} from './types.js';
import { record, text } from './value.js';

const BROKER_URL = 'wss://post-cn-7mz2e5hc90i.mqtt.aliyuncs.com/:443/mqtt';
const CREDENTIAL_URL = 'https://www.5eplay.com/api/restrict/matchscore';

interface Credentials {
  clientId: string;
  username: string;
  password: string;
}

export interface DecodedMqttPacket {
  type: number;
  flags: number;
  payload: Uint8Array;
  topic?: string;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function mqttString(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength > 65_535) throw new Error('MQTT string is too long');
  return concatBytes([
    Uint8Array.of(encoded.byteLength >> 8, encoded.byteLength & 0xff),
    encoded,
  ]);
}

function remainingLength(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let digit = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) digit |= 0x80;
    bytes.push(digit);
  } while (remaining > 0);
  return Uint8Array.from(bytes);
}

function packet(header: number, body: Uint8Array): Uint8Array {
  return concatBytes([Uint8Array.of(header), remainingLength(body.byteLength), body]);
}

export function encodeConnectPacket(credentials: Credentials, keepAliveSeconds = 30): Uint8Array {
  const variableHeader = concatBytes([
    mqttString('MQTT'),
    Uint8Array.of(4, 0xc2, keepAliveSeconds >> 8, keepAliveSeconds & 0xff),
  ]);
  const payload = concatBytes([
    mqttString(credentials.clientId),
    mqttString(credentials.username),
    mqttString(credentials.password),
  ]);
  return packet(0x10, concatBytes([variableHeader, payload]));
}

export function encodeSubscribePacket(topic: string, packetId = 1): Uint8Array {
  return packet(0x82, concatBytes([
    Uint8Array.of(packetId >> 8, packetId & 0xff),
    mqttString(topic),
    Uint8Array.of(0),
  ]));
}

export function decodeMqttPackets(bytes: Uint8Array): DecodedMqttPacket[] {
  const packets: DecodedMqttPacket[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const first = bytes[offset++];
    if (first === undefined) break;
    let multiplier = 1;
    let length = 0;
    let digit: number;
    do {
      digit = bytes[offset++] ?? 0;
      length += (digit & 0x7f) * multiplier;
      multiplier *= 128;
      if (multiplier > 128 * 128 * 128 * 128) throw new Error('invalid MQTT remaining length');
    } while ((digit & 0x80) !== 0);
    const end = offset + length;
    if (end > bytes.byteLength) throw new Error('incomplete MQTT packet');
    const type = first >> 4;
    const flags = first & 0x0f;
    let payload = bytes.subarray(offset, end);
    let topic: string | undefined;
    if (type === 3) {
      const topicLength = (payload[0] ?? 0) * 256 + (payload[1] ?? 0);
      const topicEnd = 2 + topicLength;
      if (topicEnd > payload.byteLength) throw new Error('invalid MQTT topic length');
      topic = new TextDecoder().decode(payload.subarray(2, topicEnd));
      const qos = (flags >> 1) & 0x03;
      payload = payload.subarray(topicEnd + (qos > 0 ? 2 : 0));
    }
    packets.push({ type, flags, payload, ...(topic === undefined ? {} : { topic }) });
    offset = end;
  }
  return packets;
}

async function eventBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (typeof data === 'string') return new TextEncoder().encode(data);
  throw new Error('unsupported WebSocket message type');
}

function defaultWebSocketFactory(url: string, protocols: string[]): FiveEPlayWebSocketLike {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new FiveEPlayError('global WebSocket is unavailable; Node.js 22 or newer is required', {
      code: 'REALTIME_CONNECTION_FAILED', operation: 'match-realtime',
      stage: 'connecting-realtime', retryable: false,
    });
  }
  return new globalThis.WebSocket(url, protocols);
}

async function credentialsFor(
  fetchImpl: typeof globalThis.fetch,
  signal: AbortSignal,
  topic: string,
): Promise<Credentials> {
  let response: Response;
  try {
    response = await fetchImpl(CREDENTIAL_URL, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic }),
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new FiveEPlayError('could not obtain 5EPlay realtime credentials', {
      code: 'REALTIME_CONNECTION_FAILED', operation: 'match-realtime',
      stage: 'connecting-realtime', retryable: true, cause: error,
    });
  }
  if (!response.ok) {
    throw new FiveEPlayError(`5EPlay realtime credential request returned HTTP ${response.status}`, {
      code: 'REALTIME_CONNECTION_FAILED', operation: 'match-realtime',
      stage: 'connecting-realtime', retryable: response.status === 429 || response.status >= 500,
      details: { status: response.status },
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(await response.text()) as unknown;
  } catch (error) {
    throw new FiveEPlayError('5EPlay realtime credential response was invalid', {
      code: 'REALTIME_CONNECTION_FAILED', operation: 'match-realtime',
      stage: 'connecting-realtime', retryable: true, cause: error,
    });
  }
  const envelope = record(value);
  const data = record(envelope.data);
  const clientId = text(data.client_id);
  const username = text(data.username);
  const password = text(data.password);
  if (envelope.success !== true || !clientId || !username || !password) {
    throw new FiveEPlayError('5EPlay realtime credentials were incomplete', {
      code: 'REALTIME_CONNECTION_FAILED', operation: 'match-realtime',
      stage: 'connecting-realtime', retryable: true,
    });
  }
  return { clientId, username, password };
}

export interface MqttTopicConnectionOptions {
  topic: string;
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
  webSocketFactory?: FiveEPlayWebSocketFactory;
  onPayload(payload: unknown): void;
}

export class MqttTopicConnection {
  readonly #topic: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #signal: AbortSignal;
  readonly #factory: FiveEPlayWebSocketFactory;
  readonly #onPayload: (payload: unknown) => void;
  #socket: FiveEPlayWebSocketLike | null = null;
  #keepAlive: ReturnType<typeof setInterval> | undefined;
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  #attempt = 0;
  #closed = false;

  constructor(options: MqttTopicConnectionOptions) {
    this.#topic = options.topic;
    this.#fetch = options.fetch;
    this.#signal = options.signal;
    this.#factory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.#onPayload = options.onPayload;
  }

  async start(): Promise<void> {
    if (this.#closed) throw new FiveEPlayError('realtime connection is closed', {
      code: 'SESSION_CLOSED', operation: 'match-realtime',
      stage: 'connecting-realtime', retryable: false,
    });
    await this.#connectOnce();
  }

  close(): void {
    this.#closed = true;
    if (this.#keepAlive) clearInterval(this.#keepAlive);
    if (this.#reconnect) clearTimeout(this.#reconnect);
    this.#socket?.close(1000, 'session closed');
    this.#socket = null;
  }

  async #connectOnce(): Promise<void> {
    const credentials = await credentialsFor(this.#fetch, this.#signal, this.#topic);
    if (this.#closed || this.#signal.aborted) throw this.#signal.reason;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = this.#factory(BROKER_URL, ['mqtt']);
      this.#socket = socket;
      socket.binaryType = 'arraybuffer';
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(new FiveEPlayError('5EPlay MQTT connection failed', {
          code: 'REALTIME_CONNECTION_FAILED', operation: 'match-realtime',
          stage: 'connecting-realtime', retryable: true, cause: error,
        }));
      };
      const onOpen: EventListener = () => {
        try {
          socket.send(encodeConnectPacket(credentials));
        } catch (error) {
          fail(error);
        }
      };
      const onMessage: EventListener = (event) => {
        void (async () => {
          const bytes = await eventBytes((event as MessageEvent<unknown>).data);
          for (const mqttPacket of decodeMqttPackets(bytes)) {
            if (mqttPacket.type === 2) {
              if ((mqttPacket.payload[1] ?? 1) !== 0) {
                fail(new Error(`MQTT CONNACK ${mqttPacket.payload[1] ?? -1}`));
                return;
              }
              socket.send(encodeSubscribePacket(this.#topic));
            } else if (mqttPacket.type === 9) {
              if (!settled) {
                settled = true;
                this.#attempt = 0;
                this.#keepAlive = setInterval(() => {
                  if (socket.readyState === 1) socket.send(Uint8Array.of(0xc0, 0));
                }, 20_000);
                resolve();
              }
            } else if (mqttPacket.type === 3 && mqttPacket.topic === this.#topic) {
              try {
                this.#onPayload(JSON.parse(new TextDecoder().decode(mqttPacket.payload)) as unknown);
              } catch {
                // Ignore malformed provider messages; the connection remains usable.
              }
            }
          }
        })().catch(fail);
      };
      const onError: EventListener = () => fail(new Error('WebSocket error'));
      const onClose: EventListener = () => {
        if (this.#keepAlive) clearInterval(this.#keepAlive);
        this.#keepAlive = undefined;
        if (!settled) fail(new Error('WebSocket closed before MQTT subscription'));
        else if (!this.#closed && !this.#signal.aborted) this.#scheduleReconnect();
      };
      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
    });
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#signal.aborted || this.#reconnect) return;
    const delay = Math.min(5_000, 250 * 2 ** this.#attempt);
    this.#attempt += 1;
    this.#reconnect = setTimeout(() => {
      this.#reconnect = undefined;
      void this.#connectOnce().catch(() => this.#scheduleReconnect());
    }, delay);
  }
}
