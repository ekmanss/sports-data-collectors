import { FiveEPlaySourceError } from '../domain/errors.js';
import { revisionFor, terminalConsistencyKey } from '../domain/revision.js';
import type {
  ConfirmedMatchObservation,
  FiveEPlayMatchSourceOptions,
  MatchUpdate,
  MatchWatch,
  ProvisionalTelemetry,
  WatchOptions,
} from '../domain/model.js';
import { waitFor } from '../internal/time.js';
import {
  asRecord,
  asString,
  deepFreeze,
  nullableNumber,
  nullableString,
  unixMilliseconds,
} from '../internal/value.js';
import {
  decodeCoreResponse,
  InconsistentProviderStateError,
  ProviderUnavailableError,
  UnsupportedFormatError,
} from '../protocol/data.js';
import type { MatchTransport, RealtimeTopic } from '../transport/port.js';
import { WatchQueue } from './watch_queue.js';

const STATE_TOPIC = (matchId: string) => `csgo/product/detail/${matchId}`;
const EVENT_TOPIC = (matchId: string) => `csgo/product/event/log/${matchId}`;

function operationTimedOut(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function providerBoutNumbers(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    try {
      const number = nullableNumber(asRecord(entry, 'MQTT map').bout_num);
      return number !== null && Number.isInteger(number) && number > 0 ? [number] : [];
    } catch {
      return [];
    }
  });
}

interface TerminalCandidate {
  readonly consistencyKey: string;
  readonly lastSeenAt: number;
  readonly observations: number;
}

class MatchWatchImpl implements MatchWatch {
  readonly #matchId: string;
  readonly #defaults: FiveEPlayMatchSourceOptions;
  readonly #transport: MatchTransport;
  readonly #controller = new AbortController();
  readonly #queue: WatchQueue;
  readonly #stateClient: RealtimeTopic;
  readonly #eventClient: RealtimeTopic;
  readonly #externalSignal: AbortSignal | undefined;
  readonly #onExternalAbort: () => void;
  #current: ConfirmedMatchObservation | null = null;
  #stateConnected = false;
  #stateEpoch = 0;
  #httpInvalidationGeneration = 0;
  #everStateConnected = false;
  #baselineCursor: string | null = null;
  #eventCursor: string | null = null;
  #stateBuffer: unknown[] = [];
  #recentStatePairs: string[] = [];
  #recentStateVersions: string[] = [];
  #resyncRunning = false;
  #resyncTask: Promise<void> | null = null;
  #resyncPending = false;
  #disposed = false;
  #iteratorCreated = false;
  #terminalCandidate: TerminalCandidate | null = null;
  #needsRecoveryConfirmation = true;

  constructor(
    matchId: string,
    defaults: FiveEPlayMatchSourceOptions,
    options: WatchOptions,
    transport: MatchTransport,
  ) {
    this.#matchId = matchId;
    this.#defaults = defaults;
    this.#transport = transport;
    this.#externalSignal = options.signal;
    this.#queue = new WatchQueue(256, (error) => this.#finish(error));
    this.#onExternalAbort = () => {
      this.#finish(
        new FiveEPlaySourceError('ABORTED', 'watch was aborted', {
          cause: options.signal?.reason,
        }),
      );
    };
    options.signal?.addEventListener('abort', this.#onExternalAbort, { once: true });
    this.#queue.push({
      kind: 'blocked',
      lastConfirmed: null,
      matchId,
      observedAt: unixMilliseconds(),
      reason: 'initializing',
    });
    this.#stateClient = transport.createRealtimeTopic({
      onPayload: (payload) => this.#handleStatePayload(payload),
      onStatus: (status, error) => this.#handleStateStatus(status, error),
      reconnectInitialMs: defaults.timing?.reconnectInitialMs ?? 1_000,
      handshakeTimeoutMs: defaults.timing?.realtimeHandshakeMs ?? 10_000,
      signal: this.#controller.signal,
      topic: STATE_TOPIC(matchId),
    });
    this.#eventClient = transport.createRealtimeTopic({
      onPayload: (payload) => this.#handleEventPayload(payload),
      onStatus: () => undefined,
      reconnectInitialMs: defaults.timing?.reconnectInitialMs ?? 1_000,
      handshakeTimeoutMs: defaults.timing?.realtimeHandshakeMs ?? 10_000,
      signal: this.#controller.signal,
      topic: EVENT_TOPIC(matchId),
    });
    this.#stateClient.start();
    this.#eventClient.start();
    void this.#pollLoop();
    if (options.signal?.aborted) this.#onExternalAbort();
  }

  current(): ConfirmedMatchObservation | null {
    return this.#current;
  }

  [Symbol.asyncIterator](): AsyncIterator<MatchUpdate> {
    if (this.#iteratorCreated) {
      throw new FiveEPlaySourceError(
        'INVALID_ARGUMENT',
        'a match watch supports exactly one async iterator',
      );
    }
    this.#iteratorCreated = true;
    return {
      next: () => this.#queue.next(),
      return: async () => {
        await this[Symbol.asyncDispose]();
        return { done: true, value: undefined };
      },
    };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#finish(null);
    await Promise.all([
      this.#stateClient.closed(),
      this.#eventClient.closed(),
      this.#resyncTask ?? Promise.resolve(),
    ]);
  }

  #handleStateStatus(status: 'connected' | 'disconnected', _error: unknown | null): void {
    if (this.#disposed) return;
    if (status === 'connected') {
      const reconnect = this.#everStateConnected;
      this.#stateEpoch += 1;
      this.#everStateConnected = true;
      this.#stateConnected = true;
      this.#terminalCandidate = null;
      this.#baselineCursor = null;
      if (reconnect) {
        this.#stateBuffer = [];
        this.#recentStatePairs = [];
        this.#recentStateVersions = [];
        this.#block('resyncing');
      }
      this.#requestResync();
      return;
    }
    this.#stateEpoch += 1;
    this.#stateConnected = false;
    this.#baselineCursor = null;
    this.#stateBuffer = [];
    this.#terminalCandidate = null;
    this.#block('realtime-unavailable');
  }

  #handleStatePayload(payload: unknown): void {
    if (this.#disposed) return;
    if (this.#baselineCursor === null) {
      if (this.#stateBuffer.length >= 256) {
        this.#stateBuffer = [];
        this.#block('version-gap');
        this.#requestResync();
      } else {
        this.#stateBuffer.push(payload);
      }
      return;
    }
    let root: Record<string, unknown>;
    let data: Record<string, unknown>;
    let match: Record<string, unknown>;
    let eventName: string;
    try {
      root = asRecord(payload, 'state MQTT payload');
      eventName = asString(root.event_name, 'state MQTT event_name');
      data = asRecord(root.data, 'state MQTT data');
      match = asRecord(data.match, 'state MQTT match');
      const matchInfo = asRecord(match.mc_info, 'state MQTT mc_info');
      if (asString(matchInfo.id, 'state MQTT match id') !== this.#matchId) {
        this.#invalidateHttp();
        this.#block('version-gap');
        this.#requestResync();
        return;
      }
    } catch {
      this.#invalidateHttp();
      this.#block('version-gap');
      this.#requestResync();
      return;
    }

    const fromVersion = nullableString(data.from_ver) ?? '';
    const toVersion = nullableString(data.this_ver) ?? '';
    if (eventName === 'csgo-detail-bp' || /^0+$/.test(fromVersion)) {
      this.#invalidateHttp();
      this.#baselineCursor = null;
      this.#recentStatePairs = [];
      this.#recentStateVersions = [];
      this.#block('resyncing');
      this.#requestResync();
      return;
    }
    if (eventName !== 'csgo-detail' || fromVersion === '' || toVersion === '') {
      this.#invalidateHttp();
      this.#block('version-gap');
      this.#requestResync();
      return;
    }
    const pair = `${fromVersion}\u0000${toVersion}`;
    if (this.#recentStatePairs.includes(pair)) return;
    if (
      fromVersion !== this.#baselineCursor ||
      fromVersion === toVersion ||
      this.#recentStateVersions.includes(toVersion)
    ) {
      this.#invalidateHttp();
      this.#baselineCursor = null;
      this.#recentStatePairs = [];
      this.#recentStateVersions = [];
      this.#block('version-gap');
      this.#requestResync();
      return;
    }
    this.#invalidateHttp();
    this.#baselineCursor = toVersion;
    this.#recentStatePairs.push(pair);
    this.#recentStateVersions.push(toVersion);
    if (this.#recentStatePairs.length > 64) this.#recentStatePairs.shift();
    if (this.#recentStateVersions.length > 65) this.#recentStateVersions.shift();
    this.#provisional({
      eventName,
      eventType: null,
      fromVersion,
      providerBoutNumbers: providerBoutNumbers(match.bouts_state),
      source: 'state-topic',
      toVersion,
    });
    this.#requestResync();
  }

  #invalidateHttp(): void {
    this.#httpInvalidationGeneration += 1;
    this.#terminalCandidate = null;
  }

  #handleEventPayload(payload: unknown): void {
    if (this.#disposed) return;
    try {
      const root = asRecord(payload, 'event MQTT payload');
      const eventName = asString(root.event_name, 'event MQTT event_name');
      if (eventName !== 'csgo-event-log') return;
      const data = asRecord(root.data, 'event MQTT data');
      const info = asRecord(data.info, 'event MQTT info');
      if (asString(info.match_id, 'event MQTT match_id') !== this.#matchId) return;
      const fromVersion = asString(data.from_ver, 'event MQTT from_ver');
      const toVersion = asString(data.to_ver, 'event MQTT to_ver');
      if (this.#eventCursor !== null && fromVersion !== this.#eventCursor) {
        this.#eventCursor = toVersion;
        return;
      }
      this.#eventCursor = toVersion;
      let eventType: string | null = null;
      const encoded = nullableString(info.log_info);
      if (encoded !== null) {
        try {
          eventType = nullableString(asRecord(JSON.parse(encoded), 'event log info').type);
        } catch {
          eventType = null;
        }
      }
      const number = nullableNumber(info.bout_num);
      this.#provisional({
        eventName,
        eventType,
        fromVersion,
        providerBoutNumbers:
          number !== null && Number.isInteger(number) && number > 0 ? [number] : [],
        source: 'event-topic',
        toVersion,
      });
    } catch {
      // Event-topic failures never invalidate the independently confirmed core state.
    }
  }

  #provisional(telemetry: ProvisionalTelemetry): void {
    this.#queue.push({
      kind: 'provisional-telemetry',
      matchId: this.#matchId,
      observedAt: unixMilliseconds(),
      revision: this.#current?.revision ?? null,
      telemetry,
    });
  }

  #block(reason: Extract<MatchUpdate, { kind: 'blocked' }>['reason']): void {
    this.#needsRecoveryConfirmation = true;
    this.#queue.push({
      kind: 'blocked',
      lastConfirmed: this.#current,
      matchId: this.#matchId,
      observedAt: unixMilliseconds(),
      reason,
    });
  }

  #requestResync(): void {
    if (this.#disposed || !this.#stateConnected) return;
    this.#resyncPending = true;
    if (!this.#resyncRunning) {
      const task = this.#drainResyncs();
      this.#resyncTask = task;
      void task.finally(() => {
        if (this.#resyncTask === task) this.#resyncTask = null;
      });
    }
  }

  async #drainResyncs(): Promise<void> {
    this.#resyncRunning = true;
    try {
      while (this.#resyncPending && !this.#disposed && this.#stateConnected) {
        this.#resyncPending = false;
        await this.#confirmFromHttp();
      }
    } finally {
      this.#resyncRunning = false;
    }
  }

  async #confirmFromHttp(): Promise<void> {
    const stateEpoch = this.#stateEpoch;
    const invalidationGeneration = this.#httpInvalidationGeneration;
    const timeoutMs = this.#defaults.timing?.coreDeadlineMs ?? 30_000;
    const signal = AbortSignal.any([this.#controller.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      const response = await this.#transport.fetchCore(this.#matchId, signal);
      if (
        this.#disposed ||
        this.#controller.signal.aborted ||
        !this.#stateConnected ||
        this.#stateEpoch !== stateEpoch ||
        this.#httpInvalidationGeneration !== invalidationGeneration
      ) return;
      if (response.kind === 'not-found') {
        this.#terminalCandidate = null;
        this.#queue.push({ kind: 'not-found', matchId: this.#matchId });
        this.#finish(null);
        return;
      }
      if (response.kind !== 'ok') {
        this.#terminalCandidate = null;
        this.#block(this.#unavailableReason());
        return;
      }
      const decoded = decodeCoreResponse(response.payload, this.#matchId, response.observedAt);
      let observation = decoded.snapshot;
      if (observation.state.lifecycle === 'closing') {
        const now = Date.now();
        const prior = this.#terminalCandidate;
        const livePollMs = this.#defaults.timing?.livePollMs ?? 5_000;
        const consistencyKey = terminalConsistencyKey(observation);
        this.#terminalCandidate =
          prior === null || prior.consistencyKey !== consistencyKey
            ? { consistencyKey, lastSeenAt: now, observations: 1 }
            : now - prior.lastSeenAt >= livePollMs
              ? {
                  ...prior,
                  lastSeenAt: now,
                  observations: prior.observations + 1,
                }
              : prior;
        const endedAt = Math.max(0, ...observation.maps.map((map) => map.endedAt ?? 0));
        const calibrationMs = this.#defaults.timing?.closeCalibrationMs ?? 180_000;
        if (
          this.#terminalCandidate.observations >= 2 &&
          endedAt > 0 &&
          now - endedAt >= calibrationMs
        ) {
          const closed = {
            ...observation,
            state: {
              ...observation.state,
              dataFinality: 'stable' as const,
              lifecycle: 'closed' as const,
            },
          };
          observation = deepFreeze({ ...closed, revision: revisionFor(closed) });
        }
      } else {
        this.#terminalCandidate = null;
      }

      const previous = this.#current;
      if (
        this.#disposed ||
        this.#controller.signal.aborted ||
        !this.#stateConnected ||
        this.#stateEpoch !== stateEpoch ||
        this.#httpInvalidationGeneration !== invalidationGeneration
      ) return;
      const needsRecoveryConfirmation = this.#needsRecoveryConfirmation;
      this.#current = observation;
      const previousBaseline = this.#baselineCursor;
      this.#baselineCursor = observation.freshness.stateVersion;
      if (
        previousBaseline !== null &&
        previousBaseline !== observation.freshness.stateVersion
      ) {
        this.#recentStatePairs = [];
        this.#recentStateVersions = [];
      }
      if (!this.#recentStateVersions.includes(observation.freshness.stateVersion)) {
        this.#recentStateVersions.push(observation.freshness.stateVersion);
      }
      if (
        previous === null ||
        previous.revision !== observation.revision ||
        previous.freshness.stateVersion !== observation.freshness.stateVersion ||
        needsRecoveryConfirmation
      ) {
        this.#queue.push({ kind: 'confirmed-state', observation });
      }
      this.#needsRecoveryConfirmation = false;
      const buffered = this.#stateBuffer;
      this.#stateBuffer = [];
      for (const payload of buffered) this.#handleStatePayload(payload);
      if (observation.state.lifecycle === 'closed') this.#finish(null);
    } catch (error) {
      if (this.#controller.signal.aborted || this.#disposed) return;
      this.#terminalCandidate = null;
      if (error instanceof InconsistentProviderStateError) {
        this.#block('inconsistent-state');
      } else if (error instanceof ProviderUnavailableError) {
        this.#block(this.#unavailableReason());
      } else if (error instanceof UnsupportedFormatError) {
        this.#queue.push({
          format: error.format,
          kind: 'unsupported',
          matchId: this.#matchId,
          reason: error.reason,
        });
        this.#finish(null);
      } else if (operationTimedOut(error)) {
        this.#block(this.#unavailableReason());
      } else {
        this.#queue.push({
          format: null,
          kind: 'unsupported',
          matchId: this.#matchId,
          reason: 'provider-schema-unsupported',
        });
        this.#finish(null);
      }
    }
  }

  async #pollLoop(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      const interval = this.#pollInterval();
      try {
        await waitFor(interval, this.#controller.signal);
      } catch {
        return;
      }
      this.#requestResync();
    }
  }

  #pollInterval(): number {
    const current = this.#current;
    if (current === null) {
      return Math.min(
        this.#defaults.timing?.nearStartPollMs ?? 10_000,
        this.#defaults.timing?.livePollMs ?? 5_000,
      );
    }
    if (current.state.lifecycle === 'live' || current.state.lifecycle === 'closing') {
      return this.#defaults.timing?.livePollMs ?? 5_000;
    }
    const untilStart = (current.match.scheduledAt ?? 0) - Date.now();
    return untilStart > 15 * 60_000
      ? this.#defaults.timing?.prestartPollMs ?? 60_000
      : this.#defaults.timing?.nearStartPollMs ?? 10_000;
  }

  #unavailableReason(): 'provider-unavailable' | 'stale-http' {
    const current = this.#current;
    if (current === null) return 'provider-unavailable';
    let maximumAge: number;
    if (current.state.lifecycle === 'live' || current.state.lifecycle === 'closing') {
      maximumAge = this.#defaults.timing?.liveMaxAgeMs ?? 20_000;
    } else {
      const untilStart = (current.match.scheduledAt ?? 0) - Date.now();
      maximumAge =
        untilStart > 15 * 60_000
          ? this.#defaults.timing?.prestartMaxAgeMs ?? 180_000
          : this.#defaults.timing?.nearStartMaxAgeMs ?? 30_000;
    }
    return Date.now() - current.freshness.coreObservedAt > maximumAge
      ? 'stale-http'
      : 'provider-unavailable';
  }

  #finish(error: unknown | null): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stateEpoch += 1;
    this.#stateConnected = false;
    this.#resyncPending = false;
    this.#terminalCandidate = null;
    this.#externalSignal?.removeEventListener('abort', this.#onExternalAbort);
    this.#controller.abort(error ?? new Error('watch finished'));
    this.#stateClient.close();
    this.#eventClient.close();
    this.#queue.close(error);
  }
}

export function createMatchWatch(
  matchId: string,
  defaults: FiveEPlayMatchSourceOptions,
  options: WatchOptions,
  transport: MatchTransport,
): MatchWatch {
  return new MatchWatchImpl(matchId, defaults, options, transport);
}
