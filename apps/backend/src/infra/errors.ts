export interface FieldError {
  readonly path: string;
  readonly message: string;
}

/**
 * Falha esperada, com um código estável legível por máquina. O handler global de erros a
 * transforma em `{ success: false, error: { code, message, details } }`. Qualquer coisa que não
 * seja um AppError é tratada como bug e respondida com um 500 genérico.
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
