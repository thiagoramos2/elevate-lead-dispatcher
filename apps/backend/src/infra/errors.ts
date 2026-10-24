export interface FieldError {
  readonly path: string;
  readonly message: string;
}

/**
 * An expected failure with a stable machine-readable code. The global error handler turns it
 * into `{ success: false, error: { code, message, details } }`. Anything that is not an
 * AppError is treated as a bug and answered with a generic 500.
 */
export class AppError extends Error {
  override readonly name = 'AppError';

  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: readonly FieldError[],
  ) {
    super(message);
  }
}

export const unprocessable = (code: string, message: string, details?: readonly FieldError[]) =>
  new AppError(422, code, message, details);

export const conflict = (code: string, message: string) => new AppError(409, code, message);

export const notFound = (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message);
