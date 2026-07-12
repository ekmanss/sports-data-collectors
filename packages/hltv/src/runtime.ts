import { HltvError } from './errors.js';
import type {
  CaptureStage,
  HltvErrorCode,
  HltvOperation,
  HltvProgressEvent,
  HltvRequestOptions,
} from './types.js';

export function retryDelayMilliseconds(
  code: HltvErrorCode,
  random = Math.random(),
): number {
  const base = code === 'ACCESS_BLOCKED' ? 10_000 : 2_000;
  const jitterRange = code === 'ACCESS_BLOCKED' ? 2_501 : 501;
  return base + Math.floor(random * jitterRange);
}

export interface OperationContext {
  operation: Exclude<HltvOperation, 'client'>;
  deadline: number;
  signal: AbortSignal;
  inputSignal?: AbortSignal;
  onProgress?: (event: HltvProgressEvent) => void;
  dispose(): void;
}

export function createOperationContext(
  operation: OperationContext['operation'],
  options: HltvRequestOptions | undefined,
  defaultTimeoutMs: number,
): OperationContext {
  if (options !== undefined && (!options || typeof options !== 'object')) {
    throw new HltvError('request options must be an object', {
      code: 'INVALID_INPUT', operation, stage: 'validating-input', retryable: false,
    });
  }
  const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900_000) {
    throw new HltvError('timeoutMs must be an integer between 1 and 900000', {
      code: 'INVALID_INPUT', operation, stage: 'validating-input', retryable: false,
    });
  }
  if (options?.onProgress !== undefined && typeof options.onProgress !== 'function') {
    throw new HltvError('onProgress must be a function', {
      code: 'INVALID_INPUT', operation, stage: 'validating-input', retryable: false,
    });
  }
  if (options?.signal !== undefined
    && (typeof options.signal !== 'object' || typeof options.signal.addEventListener !== 'function')) {
    throw new HltvError('signal must be an AbortSignal', {
      code: 'INVALID_INPUT', operation, stage: 'validating-input', retryable: false,
    });
  }
  if (options?.signal?.aborted) {
    throw new HltvError('operation was aborted before it started', {
      code: 'ABORTED', operation, stage: 'validating-input', retryable: false,
    });
  }

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort('timeout'), timeoutMs);
  const signal = options?.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  return {
    operation,
    deadline: Date.now() + timeoutMs,
    signal,
    inputSignal: options?.signal,
    onProgress: options?.onProgress,
    dispose: () => clearTimeout(timer),
  };
}

export function remainingMs(context: OperationContext): number {
  return Math.max(0, context.deadline - Date.now());
}

export function throwIfStopped(
  context: OperationContext,
  stage: CaptureStage,
  matchId?: number,
): void {
  if (!context.signal.aborted && remainingMs(context) > 0) return;
  const timedOut = !context.inputSignal?.aborted;
  throw new HltvError(timedOut ? 'operation timed out' : 'operation was aborted', {
    code: timedOut ? 'TIMEOUT' : 'ABORTED',
    operation: context.operation,
    stage,
    retryable: timedOut,
    matchId,
  });
}

export function emitProgress(
  context: OperationContext,
  event: Omit<HltvProgressEvent, 'operation' | 'timestamp'>,
): void {
  try {
    context.onProgress?.({ ...event, operation: context.operation, timestamp: new Date().toISOString() });
  } catch {
    // Progress is observational and must not change capture behavior.
  }
}

export async function abortableDelay(
  milliseconds: number,
  context: OperationContext,
  stage: CaptureStage,
  matchId?: number,
): Promise<void> {
  throwIfStopped(context, stage, matchId);
  const duration = Math.min(milliseconds, remainingMs(context));
  if (duration <= 0) throwIfStopped(context, stage, matchId);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, duration);
    function cleanup(): void {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', stopped);
    }
    function done(): void {
      cleanup();
      resolve();
    }
    function stopped(): void {
      cleanup();
      try {
        throwIfStopped(context, stage, matchId);
      } catch (error) {
        reject(error);
      }
    }
    context.signal.addEventListener('abort', stopped, { once: true });
  });
  throwIfStopped(context, stage, matchId);
}

export function navigationTimeout(context: OperationContext, capMs = 90_000): number {
  throwIfStopped(context, 'navigating');
  return Math.max(1, Math.min(capMs, remainingMs(context)));
}
