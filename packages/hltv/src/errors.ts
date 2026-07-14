import type { CaptureStage, HltvErrorCode, HltvOperation } from './types.js';

export interface HltvErrorOptions {
  code: HltvErrorCode;
  operation: HltvOperation;
  stage: CaptureStage;
  retryable: boolean;
  matchId?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

function safeCause(cause: unknown): Error | undefined {
  if (cause === undefined) return undefined;
  const message = (cause instanceof Error ? cause.message : String(cause))
    .replace(/(https?:\/\/|socks5:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***:***@')
    .replace(/((?:password|token|secret)=)[^&\s]+/gi, '$1***');
  return new Error(message);
}

export class HltvError extends Error {
  readonly code: HltvErrorCode;
  readonly operation: HltvOperation;
  readonly stage: CaptureStage;
  readonly retryable: boolean;
  readonly matchId?: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: HltvErrorOptions) {
    super(message, { cause: safeCause(options.cause) });
    this.name = 'HltvError';
    this.code = options.code;
    this.operation = options.operation;
    this.stage = options.stage;
    this.retryable = options.retryable;
    this.matchId = options.matchId;
    this.details = options.details;
  }
}

export function asHltvError(error: unknown, fallback: HltvErrorOptions): HltvError {
  if (error instanceof HltvError) return error;
  return new HltvError(error instanceof Error ? error.message : String(error), {
    ...fallback,
    cause: error,
  });
}

export function withHltvErrorDetails(
  error: HltvError,
  details: Record<string, unknown>,
): HltvError {
  return new HltvError(error.message, {
    code: error.code,
    operation: error.operation,
    stage: error.stage,
    retryable: error.retryable,
    ...(error.matchId === undefined ? {} : { matchId: error.matchId }),
    details: { ...error.details, ...details },
    cause: error.cause,
  });
}
