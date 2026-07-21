import type {
  DiagnosticEvent,
  EvidenceRecord,
  FiveEPlayMatchSourceOptions,
} from '../domain/model.js';
import { unixMilliseconds } from './value.js';

const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|token/i;

function redactedAttributes(
  attributes: DiagnosticEvent['attributes'],
): DiagnosticEvent['attributes'] {
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[redacted]' : value,
    ]),
  );
}

export function emitDiagnostic(
  options: FiveEPlayMatchSourceOptions,
  event: Omit<DiagnosticEvent, 'observedAt'> & { readonly observedAt?: DiagnosticEvent['observedAt'] },
): void {
  if (options.onDiagnostic === undefined) return;
  const diagnostic: DiagnosticEvent = {
    ...event,
    attributes: redactedAttributes(event.attributes),
    observedAt: event.observedAt ?? unixMilliseconds(),
  };
  try {
    const result = options.onDiagnostic(diagnostic);
    if (result instanceof Promise) void result.catch(() => undefined);
  } catch {
    // Diagnostics are deliberately non-interfering.
  }
}

export function emitEvidence(
  options: FiveEPlayMatchSourceOptions,
  record: EvidenceRecord,
): void {
  if (options.evidenceSink === undefined) return;
  const failed = (): void => {
    emitDiagnostic(options, {
      attributes: { evidenceRef: record.evidenceRef, kind: record.kind },
      code: 'EVIDENCE_SINK_FAILED',
      matchId: record.matchId,
      message: 'The configured evidence sink rejected a best-effort record',
      severity: 'warning',
    });
  };
  try {
    const result = options.evidenceSink(record);
    if (result instanceof Promise) void result.catch(failed);
  } catch {
    failed();
  }
}
