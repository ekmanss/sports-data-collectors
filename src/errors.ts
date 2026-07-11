import type { CaptureStage, HltvMatchErrorCode } from './types.js';

export interface HltvMatchErrorOptions {
  code: HltvMatchErrorCode;
  stage: CaptureStage;
  retryable: boolean;
  matchId?: string;
  slug?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class HltvMatchError extends Error {
  readonly code: HltvMatchErrorCode;
  readonly stage: CaptureStage;
  readonly retryable: boolean;
  readonly matchId?: string;
  readonly slug?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: HltvMatchErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'HltvMatchError';
    this.code = options.code;
    this.stage = options.stage;
    this.retryable = options.retryable;
    this.matchId = options.matchId;
    this.slug = options.slug;
    this.details = options.details;
  }
}

export function asHltvMatchError(error: unknown, fallback: HltvMatchErrorOptions): HltvMatchError {
  if (error instanceof HltvMatchError) return error;
  return new HltvMatchError(error instanceof Error ? error.message : String(error), { ...fallback, cause: error });
}
