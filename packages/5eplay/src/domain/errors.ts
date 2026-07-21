export type FiveEPlaySourceErrorCode =
  | 'ABORTED'
  | 'INVALID_ARGUMENT'
  | 'PROVIDER_FAILURE';

export class FiveEPlaySourceError extends Error {
  readonly code: FiveEPlaySourceErrorCode;

  constructor(code: FiveEPlaySourceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FiveEPlaySourceError';
    this.code = code;
  }
}
