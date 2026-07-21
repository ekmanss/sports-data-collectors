type Listener = (event: { readonly data?: Uint8Array }) => void;

function mqttRemainingLength(value: number): Uint8Array {
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

function mqttString(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  return Uint8Array.from([
    encoded.byteLength >> 8,
    encoded.byteLength & 0xff,
    ...encoded,
  ]);
}

function publishPacket(topic: string, payload: unknown): Uint8Array {
  const body = Uint8Array.from([
    ...mqttString(topic),
    ...new TextEncoder().encode(JSON.stringify(payload)),
  ]);
  return Uint8Array.from([0x30, ...mqttRemainingLength(body.byteLength), ...body]);
}

function bodyOffset(packet: Uint8Array): number {
  let offset = 1;
  while (((packet[offset] ?? 0) & 0x80) !== 0) offset += 1;
  return offset + 1;
}

class FakeWebSocket {
  binaryType = 'blob';
  readyState = 0;
  topic: string | null = null;
  readonly #listeners = new Map<string, Listener[]>();
  readonly #broker: FakeMqttBroker;
  constructor(broker: FakeMqttBroker) {
    this.#broker = broker;
    broker.sockets.push(this);
    broker.onSocketCreated?.();
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      this.readyState = 1;
      this.#emit('open', {});
    });
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  send(value: ArrayBuffer | ArrayBufferView): void {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (bytes[0] === 0x10) {
      queueMicrotask(() => this.receive(Uint8Array.of(0x20, 0x02, 0, 0)));
      return;
    }
    if (bytes[0] === 0x82) {
      const offset = bodyOffset(bytes) + 2;
      const length = (bytes[offset] ?? 0) * 256 + (bytes[offset + 1] ?? 0);
      this.topic = new TextDecoder().decode(bytes.subarray(offset + 2, offset + 2 + length));
      if (!this.#broker.suppressSuback) {
        queueMicrotask(() =>
          this.receive(Uint8Array.of(0x90, 0x03, 0, 1, this.#broker.subackCode)),
        );
      }
    }
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.#emit('close', {}));
  }

  receive(bytes: Uint8Array): void {
    if (this.readyState === 3) return;
    this.#emit('message', { data: bytes });
  }

  fail(): void {
    this.close();
  }

  #emit(type: string, event: { readonly data?: Uint8Array }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

export class FakeMqttBroker {
  readonly sockets: FakeWebSocket[] = [];
  onSocketCreated: (() => void) | null = null;
  subackCode = 0;
  suppressSuback = false;
  readonly #original = globalThis.WebSocket;

  install(): void {
    const broker = this;
    globalThis.WebSocket = class {
      constructor() {
        return new FakeWebSocket(broker);
      }
    } as unknown as typeof WebSocket;
  }

  restore(): void {
    globalThis.WebSocket = this.#original;
  }

  closeAll(): void {
    for (const socket of this.sockets) socket.close();
  }

  publish(topic: string, payload: unknown): void {
    const packet = publishPacket(topic, payload);
    const socket = this.sockets.find((candidate) => candidate.topic === topic);
    if (socket === undefined) throw new Error(`no subscription for ${topic}`);
    socket.receive(packet);
  }

  publishMalformed(topic: string): void {
    const body = Uint8Array.from([
      ...mqttString(topic),
      ...new TextEncoder().encode('{'),
    ]);
    const packet = Uint8Array.from([0x30, ...mqttRemainingLength(body.byteLength), ...body]);
    const socket = this.sockets.find((candidate) => candidate.topic === topic);
    if (socket === undefined) throw new Error(`no subscription for ${topic}`);
    socket.receive(packet);
  }

  disconnect(topic: string): void {
    const socket = this.sockets.find((candidate) => candidate.topic === topic);
    if (socket === undefined) throw new Error(`no subscription for ${topic}`);
    socket.fail();
  }
}
