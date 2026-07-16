import type {
  FiveEPlayErrorCode,
  FiveEPlayOperation,
  FiveEPlayStage,
} from './types.js';

export interface FiveEPlayErrorOptions {
  code: FiveEPlayErrorCode;
  operation: FiveEPlayOperation;
  stage: FiveEPlayStage;
  retryable: boolean;
  matchId?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

function safeCause(cause: unknown): Error | undefined {
  if (cause === undefined) return undefined;
  const message = (cause instanceof Error ? cause.message : String(cause))
    .replace(/(client_id|username|password)["'=:\s]+[^,}\s]+/gi, '$1=***')
    .replace(/(https?:\/\/|wss:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***:***@');
  return new Error(message);
}

export class FiveEPlayError extends Error {
  readonly code: FiveEPlayErrorCode;
  readonly operation: FiveEPlayOperation;
  readonly stage: FiveEPlayStage;
  readonly retryable: boolean;
  readonly matchId?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: FiveEPlayErrorOptions) {
    super(message, { cause: safeCause(options.cause) });
    this.name = 'FiveEPlayError';
    this.code = options.code;
    this.operation = options.operation;
    this.stage = options.stage;
    this.retryable = options.retryable;
    this.matchId = options.matchId;
    this.details = options.details;
  }
}

export function asFiveEPlayError(
  error: unknown,
  fallback: FiveEPlayErrorOptions,
): FiveEPlayError {
  if (error instanceof FiveEPlayError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new FiveEPlayError('5EPlay operation was aborted', {
      ...fallback,
      code: 'ABORTED',
      retryable: false,
      cause: error,
    });
  }
  return new FiveEPlayError(error instanceof Error ? error.message : String(error), {
    ...fallback,
    cause: error,
  });
}
