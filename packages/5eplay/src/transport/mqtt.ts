import { asRecord, asString } from '../internal/value.js';
import { waitFor } from '../internal/time.js';

const BROKER_URL = 'wss://post-cn-7mz2e5hc90i.mqtt.aliyuncs.com/:443/mqtt';
const CREDENTIAL_URL = 'https://www.5eplay.com/api/restrict/matchscore';

interface Credentials {
  readonly clientId: string;
  readonly username: string;
  readonly password: string;
}

interface DecodedMqttPacket {
  readonly type: number;
  readonly flags: number;
  readonly payload: Uint8Array;
  readonly topic: string | null;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function mqttString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > 65_535) throw new TypeError('MQTT string exceeds protocol limit');
  return concatBytes([
    Uint8Array.of(bytes.byteLength >> 8, bytes.byteLength & 0xff),
    bytes,
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

function connectPacket(credentials: Credentials): Uint8Array {
  const variableHeader = concatBytes([
    mqttString('MQTT'),
    Uint8Array.of(4, 0xc2, 0, 30),
  ]);
  const payload = concatBytes([
    mqttString(credentials.clientId),
    mqttString(credentials.username),
    mqttString(credentials.password),
  ]);
  return packet(0x10, concatBytes([variableHeader, payload]));
}

function subscribePacket(topic: string): Uint8Array {
  return packet(0x82, concatBytes([Uint8Array.of(0, 1), mqttString(topic), Uint8Array.of(0)]));
}

function decodePackets(bytes: Uint8Array): readonly DecodedMqttPacket[] {
  const packets: DecodedMqttPacket[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const first = bytes[offset];
    if (first === undefined) throw new TypeError('incomplete MQTT fixed header');
    offset += 1;
    let multiplier = 1;
    let length = 0;
    let digit = 0;
    do {
      digit = bytes[offset] ?? -1;
      if (digit < 0) throw new TypeError('incomplete MQTT remaining length');
      offset += 1;
      length += (digit & 0x7f) * multiplier;
      multiplier *= 128;
      if (multiplier > 128 ** 4) throw new TypeError('invalid MQTT remaining length');
    } while ((digit & 0x80) !== 0);
    const end = offset + length;
    if (end > bytes.byteLength) throw new TypeError('incomplete MQTT packet');
    const type = first >> 4;
    const flags = first & 0x0f;
    let payload = bytes.subarray(offset, end);
    let topic: string | null = null;
    if (type === 3) {
      const topicLength = (payload[0] ?? 0) * 256 + (payload[1] ?? 0);
      const topicEnd = 2 + topicLength;
      if (topicEnd > payload.byteLength) throw new TypeError('invalid MQTT publish topic');
      topic = new TextDecoder().decode(payload.subarray(2, topicEnd));
      const qos = (flags >> 1) & 0x03;
      payload = payload.subarray(topicEnd + (qos > 0 ? 2 : 0));
    }
    packets.push({ flags, payload, topic, type });
    offset = end;
  }
  return packets;
}

async function messageBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (typeof value === 'string') return new TextEncoder().encode(value);
  throw new TypeError('unsupported WebSocket message data');
}

async function credentialsFor(topic: string, signal: AbortSignal): Promise<Credentials> {
  const response = await fetch(CREDENTIAL_URL, {
    body: JSON.stringify({ topic }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    signal,
  });
  if (!response.ok) throw new Error(`credential request returned HTTP ${response.status}`);
  const envelope = asRecord(await response.json(), 'MQTT credential response');
  if (envelope.success !== true) throw new TypeError('MQTT credential response was unsuccessful');
  const data = asRecord(envelope.data, 'MQTT credential response.data');
  return {
    clientId: asString(data.client_id, 'MQTT client_id'),
    password: asString(data.password, 'MQTT password'),
    username: asString(data.username, 'MQTT username'),
  };
}

export interface MqttTopicClientOptions {
  readonly topic: string;
  readonly signal: AbortSignal;
  readonly onPayload: (payload: unknown) => void;
  readonly onStatus: (status: 'connected' | 'disconnected', error: unknown | null) => void;
  readonly reconnectInitialMs?: number;
  readonly handshakeTimeoutMs?: number;
}

export class MqttTopicClient {
  readonly #options: MqttTopicClientOptions;
  readonly #lifetime = new AbortController();
  readonly #signal: AbortSignal;
  #socket: WebSocket | null = null;
  #running: Promise<void> | null = null;

  constructor(options: MqttTopicClientOptions) {
    this.#options = options;
    this.#signal = AbortSignal.any([options.signal, this.#lifetime.signal]);
  }

  start(): void {
    if (this.#running !== null) return;
    this.#running = this.#run();
  }

  close(): void {
    if (!this.#lifetime.signal.aborted) {
      this.#lifetime.abort(new Error('MQTT client closed'));
    }
    this.#socket?.close(1000, 'watch disposed');
    this.#socket = null;
  }

  closed(): Promise<void> {
    return this.#running ?? Promise.resolve();
  }

  async #run(): Promise<void> {
    let attempt = 0;
    while (!this.#signal.aborted) {
      try {
        const connection = await this.#connectOnce();
        attempt = 0;
        this.#options.onStatus('connected', null);
        await connection.closed;
        if (!this.#signal.aborted) {
          this.#options.onStatus('disconnected', new Error('MQTT socket closed'));
        }
      } catch (error) {
        if (this.#signal.aborted) return;
        this.#options.onStatus('disconnected', error);
      }
      const initial = this.#options.reconnectInitialMs ?? 1_000;
      const schedule = [initial, initial * 2, initial * 5, initial * 10, initial * 20, initial * 30];
      const base = schedule[Math.min(attempt, schedule.length - 1)] ?? 30_000;
      attempt += 1;
      const jittered = Math.round(base * (0.8 + Math.random() * 0.4));
      try {
        await waitFor(jittered, this.#signal);
      } catch {
        return;
      }
    }
  }

  async #connectOnce(): Promise<{ readonly closed: Promise<void> }> {
    const handshakeTimeoutMs = this.#options.handshakeTimeoutMs ?? 10_000;
    const credentials = await credentialsFor(
      this.#options.topic,
      AbortSignal.any([this.#signal, AbortSignal.timeout(handshakeTimeoutMs)]),
    );
    this.#signal.throwIfAborted();
    if (typeof globalThis.WebSocket !== 'function') {
      throw new Error('global WebSocket is unavailable');
    }
    const socket = new globalThis.WebSocket(BROKER_URL, ['mqtt']);
    this.#socket = socket;
    socket.binaryType = 'arraybuffer';
    let subscribed = false;
    let resolveClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    let lastPacketAt = Date.now();
    const closed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });

    await new Promise<void>((resolve, reject) => {
      let abortHandled = false;
      let handshakeTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        fail(new Error('MQTT handshake timed out'));
      }, handshakeTimeoutMs);
      const clearHandshakeTimer = (): void => {
        if (handshakeTimer === null) return;
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      };
      const closeWithProtocolError = (): void => {
        try {
          socket.close(1002, 'MQTT protocol error');
        } catch {
          resolveClosed();
        }
      };
      const fail = (error: unknown): void => {
        if (subscribed) {
          rejectClosed(error);
          closeWithProtocolError();
          return;
        }
        clearHandshakeTimer();
        closeWithProtocolError();
        reject(error);
      };
      const onAbort = (): void => {
        if (abortHandled) return;
        abortHandled = true;
        clearHandshakeTimer();
        try {
          socket.close(1000, 'aborted');
        } finally {
          if (!subscribed) reject(this.#signal.reason);
          resolveClosed();
        }
      };
      this.#signal.addEventListener('abort', onAbort, { once: true });
      if (this.#signal.aborted) {
        onAbort();
        return;
      }
      socket.addEventListener('open', () => {
        try {
          socket.send(connectPacket(credentials));
        } catch (error) {
          fail(error);
        }
      });
      socket.addEventListener('message', (event) => {
        void (async () => {
          const bytes = await messageBytes(event.data);
          for (const mqttPacket of decodePackets(bytes)) {
            lastPacketAt = Date.now();
            if (mqttPacket.type === 2) {
              if (mqttPacket.payload.byteLength !== 2 || (mqttPacket.payload[1] ?? 1) !== 0) {
                throw new Error(`MQTT CONNACK rejected with ${mqttPacket.payload[1] ?? -1}`);
              }
              socket.send(subscribePacket(this.#options.topic));
            } else if (mqttPacket.type === 9) {
              if (!subscribed) {
                if (
                  mqttPacket.payload.byteLength !== 3 ||
                  mqttPacket.payload[0] !== 0 ||
                  mqttPacket.payload[1] !== 1 ||
                  mqttPacket.payload[2] !== 0
                ) {
                  throw new Error('MQTT SUBACK rejected or used an unexpected packet identifier');
                }
                subscribed = true;
                clearHandshakeTimer();
                resolve();
              }
            } else if (mqttPacket.type === 3 && mqttPacket.topic === this.#options.topic) {
              const payload = JSON.parse(new TextDecoder().decode(mqttPacket.payload)) as unknown;
              this.#options.onPayload(payload);
            }
          }
        })().catch(fail);
      });
      socket.addEventListener('error', () => fail(new Error('WebSocket error')));
      socket.addEventListener('close', () => {
        clearHandshakeTimer();
        this.#signal.removeEventListener('abort', onAbort);
        if (this.#socket === socket) this.#socket = null;
        if (!subscribed) reject(new Error('WebSocket closed before SUBACK'));
        resolveClosed();
      });
    });

    const keepAlive = setInterval(() => {
      if (socket.readyState !== 1) return;
      if (Date.now() - lastPacketAt > 45_000) {
        socket.close(1001, 'MQTT keepalive timeout');
        return;
      }
      try {
        socket.send(Uint8Array.of(0xc0, 0));
      } catch (error) {
        rejectClosed(error);
        socket.close(1001, 'MQTT keepalive send failed');
      }
    }, 20_000);
    return { closed: closed.finally(() => clearInterval(keepAlive)) };
  }
}
