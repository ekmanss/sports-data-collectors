import { FiveEPlaySourceError } from '../domain/errors.js';
import { revisionFor, terminalConsistencyKey } from '../domain/revision.js';
import type {
  ConfirmedMatchObservation,
  FiveEPlayMatchSource,
  FiveEPlayMatchSourceOptions,
  MatchSnapshot,
  MatchSnapshotResult,
  ScheduleOptions,
  SchedulePageResult,
  SnapshotOptions,
  WatchOptions,
} from '../domain/model.js';
import { loadMatchDetails } from '../details/load.js';
import { waitFor } from '../internal/time.js';
import { deepFreeze, unixMilliseconds } from '../internal/value.js';
import { emitDiagnostic, emitEvidence } from '../internal/hooks.js';
import {
  decodeCoreResponse,
  InconsistentProviderStateError,
  ProviderUnavailableError,
  UnsupportedFormatError,
} from '../protocol/data.js';
import { createMatchWatch } from '../sync/watch.js';
import { loadSchedulePage } from '../schedule/load.js';
import type { MatchTransport } from '../transport/port.js';
import { productionTransport } from '../transport/production.js';

const DEFAULT_CORE_DEADLINE_MS = 30_000;
const DEFAULT_DETAIL_DEADLINE_MS = 60_000;
const DEFAULT_EVENT_DEADLINE_MS = 120_000;
const DEFAULT_SCHEDULE_DEADLINE_MS = 15_000;
const MATCH_ID = /^csgo_mc_[1-9]\d*$/;

function positiveFinite(name: string, value: number, maximum: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new FiveEPlaySourceError(
      'INVALID_ARGUMENT',
      `${name} must be finite, positive, and at most ${maximum}`,
    );
  }
  return value;
}

function normalizedOptions(
  options: FiveEPlayMatchSourceOptions,
): FiveEPlayMatchSourceOptions {
  const prestartPollMs = positiveFinite(
    'timing.prestartPollMs',
    options.timing?.prestartPollMs ?? 60_000,
    300_000,
  );
  const nearStartPollMs = positiveFinite(
    'timing.nearStartPollMs',
    options.timing?.nearStartPollMs ?? 10_000,
    300_000,
  );
  const livePollMs = positiveFinite(
    'timing.livePollMs',
    options.timing?.livePollMs ?? 5_000,
    60_000,
  );
  const prestartMaxAgeMs = positiveFinite(
    'timing.prestartMaxAgeMs',
    options.timing?.prestartMaxAgeMs ?? Math.max(180_000, prestartPollMs * 3),
    3_600_000,
  );
  const nearStartMaxAgeMs = positiveFinite(
    'timing.nearStartMaxAgeMs',
    options.timing?.nearStartMaxAgeMs ?? Math.max(30_000, nearStartPollMs * 3),
    3_600_000,
  );
  const liveMaxAgeMs = positiveFinite(
    'timing.liveMaxAgeMs',
    options.timing?.liveMaxAgeMs ?? Math.max(20_000, livePollMs * 3),
    3_600_000,
  );
  if (
    prestartMaxAgeMs <= prestartPollMs ||
    nearStartMaxAgeMs <= nearStartPollMs ||
    liveMaxAgeMs <= livePollMs
  ) {
    throw new FiveEPlaySourceError(
      'INVALID_ARGUMENT',
      'each freshness maximum must be greater than its polling interval',
    );
  }
  const eventPages = options.limits?.eventPages ?? 200;
  const events = options.limits?.events ?? 100_000;
  const eventPageSize = options.limits?.eventPageSize ?? 500;
  const teamHistoryPages = options.limits?.teamHistoryPages ?? 200;
  if (
    !Number.isInteger(eventPages) ||
    eventPages <= 0 ||
    eventPages > 10_000 ||
    !Number.isInteger(events) ||
    events <= 0 ||
    events > 1_000_000 ||
    !Number.isInteger(eventPageSize) ||
    eventPageSize <= 0 ||
    eventPageSize > 500 ||
    !Number.isInteger(teamHistoryPages) ||
    teamHistoryPages <= 0 ||
    teamHistoryPages > 1_000
  ) {
    throw new FiveEPlaySourceError('INVALID_ARGUMENT', 'source event limits are outside safety bounds');
  }
  return deepFreeze({
    ...(options.evidenceSink === undefined ? {} : { evidenceSink: options.evidenceSink }),
    limits: { eventPageSize, eventPages, events, teamHistoryPages },
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    timing: {
      closeCalibrationMs: positiveFinite(
        'timing.closeCalibrationMs',
        options.timing?.closeCalibrationMs ?? 180_000,
        86_400_000,
      ),
      coreDeadlineMs: positiveFinite(
        'timing.coreDeadlineMs',
        options.timing?.coreDeadlineMs ?? DEFAULT_CORE_DEADLINE_MS,
        600_000,
      ),
      detailDeadlineMs: positiveFinite(
        'timing.detailDeadlineMs',
        options.timing?.detailDeadlineMs ?? DEFAULT_DETAIL_DEADLINE_MS,
        600_000,
      ),
      eventDeadlineMs: positiveFinite(
        'timing.eventDeadlineMs',
        options.timing?.eventDeadlineMs ?? DEFAULT_EVENT_DEADLINE_MS,
        600_000,
      ),
      liveMaxAgeMs,
      livePollMs,
      nearStartMaxAgeMs,
      nearStartPollMs,
      prestartMaxAgeMs,
      prestartPollMs,
      reconnectInitialMs: positiveFinite(
        'timing.reconnectInitialMs',
        options.timing?.reconnectInitialMs ?? 1_000,
        60_000,
      ),
      realtimeHandshakeMs: positiveFinite(
        'timing.realtimeHandshakeMs',
        options.timing?.realtimeHandshakeMs ?? 10_000,
        60_000,
      ),
    },
  });
}

function validateMatchId(matchId: string): void {
  if (!MATCH_ID.test(matchId)) {
    throw new FiveEPlaySourceError(
      'INVALID_ARGUMENT',
      'matchId must use the provider form csgo_mc_<positive integer>',
    );
  }
}

function deadlineSignal(
  deadlineMs: number,
  callerSignal: AbortSignal | undefined,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 600_000) {
    throw new FiveEPlaySourceError(
      'INVALID_ARGUMENT',
      'deadlineMs must be a finite number between 1 and 600000',
    );
  }
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => {
    timeoutController.abort(new DOMException('The operation timed out', 'TimeoutError'));
  }, deadlineMs);
  const dispose = (): void => clearTimeout(timeout);
  if (callerSignal === undefined) return { dispose, signal: timeoutController.signal };
  return {
    dispose,
    signal: AbortSignal.any([callerSignal, timeoutController.signal]),
  };
}

function stableClosedCandidate(
  observation: ConfirmedMatchObservation,
  closeCalibrationMs: number,
): ConfirmedMatchObservation | null {
  if (observation.state.lifecycle !== 'closing') return null;
  if (observation.providerState.globalStatusCode !== 2) return null;
  const terminalEndedAt = Math.max(0, ...observation.maps.map((map) => map.endedAt ?? 0));
  if (terminalEndedAt === 0 || Date.now() - terminalEndedAt < closeCalibrationMs) return null;
  const closed = {
    ...observation,
    state: {
      ...observation.state,
      dataFinality: 'stable' as const,
      lifecycle: 'closed' as const,
    },
  };
  return deepFreeze({ ...closed, revision: revisionFor(closed) });
}

function operationTimedOut(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

async function snapshot(
  matchId: string,
  options: SnapshotOptions,
  defaults: FiveEPlayMatchSourceOptions,
  transport: MatchTransport,
): Promise<MatchSnapshotResult> {
  validateMatchId(matchId);
  const deadlineMs = options.deadlineMs ?? defaults.timing?.eventDeadlineMs ?? DEFAULT_EVENT_DEADLINE_MS;
  const deadline = deadlineSignal(deadlineMs, options.signal);
  try {
    const maximumAttempts = options.expectedRevision === undefined ? 2 : 1;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const newCoreSignal = (): AbortSignal =>
        AbortSignal.any([
          deadline.signal,
          AbortSignal.timeout(defaults.timing?.coreDeadlineMs ?? DEFAULT_CORE_DEADLINE_MS),
        ]);
      const beforeResponse = await transport.fetchCore(matchId, newCoreSignal());
      if (beforeResponse.kind === 'not-found') return { kind: 'not-found', matchId };
      if (beforeResponse.kind !== 'ok') {
        return {
          kind: 'blocked',
          matchId,
          observedAt: beforeResponse.observedAt,
          reason: 'provider-unavailable',
        };
      }
      const before = decodeCoreResponse(beforeResponse.payload, matchId, beforeResponse.observedAt);
      const closeCalibrationMs = defaults.timing?.closeCalibrationMs ?? 180_000;
      const stableBefore = stableClosedCandidate(before.snapshot, closeCalibrationMs);
      const effectiveBefore = stableBefore ?? before.snapshot;
      if (
        options.expectedRevision !== undefined &&
        options.expectedRevision !== effectiveBefore.revision
      ) {
        return {
          expectedRevision: options.expectedRevision,
          kind: 'superseded',
          matchId,
          observedRevision: effectiveBefore.revision,
        };
      }
      const maximumPages =
        options.eventLimits?.maxPages ?? defaults.limits?.eventPages ?? 200;
      const maximumEvents =
        options.eventLimits?.maxEvents ?? defaults.limits?.events ?? 100_000;
      const eventPageSize = defaults.limits?.eventPageSize ?? 500;
      if (
        !Number.isInteger(maximumPages) ||
        maximumPages <= 0 ||
        maximumPages > 10_000 ||
        !Number.isInteger(maximumEvents) ||
        maximumEvents <= 0 ||
        maximumEvents > 1_000_000 ||
        !Number.isInteger(eventPageSize) ||
        eventPageSize <= 0 ||
        eventPageSize > 500
      ) {
        throw new FiveEPlaySourceError(
          'INVALID_ARGUMENT',
          'event limits must be finite positive integers within their safety bounds',
        );
      }
      const teamIds = [before.snapshot.teams[0].id, before.snapshot.teams[1].id] as const;
      const details = await loadMatchDetails(
        transport,
        matchId,
        teamIds,
        before.snapshot.tournament.id,
        before.snapshot.maps,
        { maxEvents: maximumEvents, maxPages: maximumPages, pageSize: eventPageSize },
        defaults.limits?.teamHistoryPages ?? 200,
        {
          detail: AbortSignal.any([
            deadline.signal,
            AbortSignal.timeout(
              defaults.timing?.detailDeadlineMs ?? DEFAULT_DETAIL_DEADLINE_MS,
            ),
          ]),
          events: AbortSignal.any([
            deadline.signal,
            AbortSignal.timeout(
              defaults.timing?.eventDeadlineMs ?? DEFAULT_EVENT_DEADLINE_MS,
            ),
          ]),
        },
      );
      if (deadline.signal.aborted) throw deadline.signal.reason;
      for (const [sectionName, section] of Object.entries(details)) {
        if (section.status === 'partial' || section.status === 'unavailable') {
          emitDiagnostic(defaults, {
            attributes: { gap: section.gap, section: sectionName },
            code: 'DETAIL_SECTION_INCOMPLETE',
            matchId,
            message: `Optional detail section ${sectionName} is ${section.status}`,
            observedAt: section.observedAt,
            severity: 'warning',
          });
        }
      }
      for (const event of details.events.data ?? []) {
        if (event.evidenceRef === null) continue;
        emitEvidence(defaults, {
          evidenceRef: event.evidenceRef,
          kind: 'match-event',
          matchId,
          observedAt: details.events.observedAt,
          payload: {
            attributes: event.attributes,
            providerBoutId: event.providerBoutId,
            type: event.type,
            updateVersion: event.updateVersion,
          },
        });
      }
      const livePollMs = defaults.timing?.livePollMs ?? 5_000;
      const canConfirmClosed = stableBefore !== null;
      if (canConfirmClosed) {
        const elapsed = Date.now() - beforeResponse.observedAt;
        await waitFor(Math.max(0, livePollMs - elapsed), deadline.signal);
      }
      const afterResponse = await transport.fetchCore(matchId, newCoreSignal());
      if (afterResponse.kind !== 'ok') {
        return {
          kind: 'blocked',
          matchId,
          observedAt: afterResponse.observedAt,
          reason: 'provider-unavailable',
        };
      }
      const after = decodeCoreResponse(afterResponse.payload, matchId, afterResponse.observedAt);
      if (before.snapshot.revision !== after.snapshot.revision) {
        const superseded: MatchSnapshotResult = {
          expectedRevision: options.expectedRevision ?? before.snapshot.revision,
          kind: 'superseded',
          matchId,
          observedRevision: after.snapshot.revision,
        };
        if (attempt + 1 < maximumAttempts) continue;
        return superseded;
      }
      const detailsCompleteness = Object.values(details).every(
        (section) =>
          section.status === 'complete' ||
          section.status === 'empty' ||
          section.status === 'not-applicable',
      )
        ? 'complete'
        : 'partial';
      const confirmedCore =
        canConfirmClosed &&
        after.snapshot.state.lifecycle === 'closing' &&
        terminalConsistencyKey(before.snapshot) === terminalConsistencyKey(after.snapshot)
          ? stableClosedCandidate(after.snapshot, closeCalibrationMs) ?? after.snapshot
          : after.snapshot;
      const completeSnapshot: MatchSnapshot = deepFreeze({
        ...confirmedCore,
        details,
        detailsCompleteness,
        revision: revisionFor(confirmedCore),
      });
      if (
        options.expectedRevision !== undefined &&
        options.expectedRevision !== completeSnapshot.revision
      ) {
        return {
          expectedRevision: options.expectedRevision,
          kind: 'superseded',
          matchId,
          observedRevision: completeSnapshot.revision,
        };
      }
      return { kind: 'confirmed', snapshot: completeSnapshot };
    }
    throw new Error('snapshot retry loop exhausted unexpectedly');
  } catch (error) {
    if (deadline.signal.aborted) {
      throw new FiveEPlaySourceError('ABORTED', 'snapshot was aborted', { cause: error });
    }
    if (error instanceof FiveEPlaySourceError) throw error;
    if (error instanceof InconsistentProviderStateError) {
      return {
        diagnosticCode: error.message
          .trim()
          .toUpperCase()
          .replaceAll(/[^A-Z0-9]+/g, '_')
          .replaceAll(/^_+|_+$/g, ''),
        kind: 'blocked',
        matchId,
        observedAt: unixMilliseconds(),
        reason: 'inconsistent-state',
      };
    }
    if (error instanceof ProviderUnavailableError) {
      return {
        kind: 'blocked',
        matchId,
        observedAt: unixMilliseconds(),
        reason: 'provider-unavailable',
      };
    }
    if (error instanceof UnsupportedFormatError) {
      return {
        format: error.format,
        kind: 'unsupported',
        matchId,
        reason: error.reason,
      };
    }
    if (operationTimedOut(error)) {
      return {
        kind: 'blocked',
        matchId,
        observedAt: unixMilliseconds(),
        reason: 'provider-unavailable',
      };
    }
    return {
      kind: 'unsupported',
      matchId,
      reason: 'provider-schema-unsupported',
      format: null,
    };
  } finally {
    deadline.dispose();
  }
}

async function schedule(
  options: ScheduleOptions,
  transport: MatchTransport,
): Promise<SchedulePageResult> {
  const page = options.page ?? 1;
  if (!Number.isSafeInteger(page) || page <= 0) {
    throw new FiveEPlaySourceError('INVALID_ARGUMENT', 'page must be a positive safe integer');
  }
  const deadline = deadlineSignal(options.deadlineMs ?? DEFAULT_SCHEDULE_DEADLINE_MS, options.signal);
  try {
    return await loadSchedulePage(transport, page, deadline.signal);
  } catch (error) {
    if (deadline.signal.aborted) {
      throw new FiveEPlaySourceError('ABORTED', 'schedule was aborted', { cause: error });
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}

export function createFiveEPlayMatchSourceWithTransport(
  options: FiveEPlayMatchSourceOptions,
  transport: MatchTransport,
): FiveEPlayMatchSource {
  const configured = normalizedOptions(options);
  return Object.freeze({
    schedule: (callOptions: ScheduleOptions = {}) => schedule(callOptions, transport),
    snapshot: (matchId: string, callOptions: SnapshotOptions = {}) =>
      snapshot(matchId, callOptions, configured, transport),
    watch: (matchId: string, watchOptions: WatchOptions = {}) => {
      validateMatchId(matchId);
      return createMatchWatch(matchId, configured, watchOptions, transport);
    },
  });
}

export function createFiveEPlayMatchSource(
  options: FiveEPlayMatchSourceOptions = {},
): FiveEPlayMatchSource {
  return createFiveEPlayMatchSourceWithTransport(options, productionTransport);
}
