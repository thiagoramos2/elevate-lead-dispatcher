import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  readonly body?: unknown;
}

function errorFrom(status: number, data: unknown): ApiError {
  if (typeof data === 'object' && data !== null && 'error' in data) {
    const error = data.error;
    if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
      return new ApiError(status, String(error.code), String(error.message));
    }
  }
  return new ApiError(status, 'HTTP_ERROR', `Request failed with status ${status}`);
}

/**
 * Chama a API (mesma origem; o Next repassa /api/* para o backend) e valida a resposta com o
 * schema do pacote `contracts`, o mesmo usado pelo backend. Contrato divergente vira erro explícito.
 */
export async function api<T extends z.ZodType>(
  path: string,
  schema: T,
  options: RequestOptions = {},
): Promise<z.output<T>> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const data: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw errorFrom(response.status, data);
  return schema.parse(data);
}

/** Monta a query string a partir dos filtros, ignorando valores vazios. */
export function toQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}
