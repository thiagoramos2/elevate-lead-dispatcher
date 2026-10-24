import type { LoggerOptions } from 'pino';

/**
 * Dados pessoais e credenciais nunca chegam aos logs. Os caminhos cobrem os headers da
 * requisição (serializers do Fastify) e os campos que as nossas chamadas de log podem carregar.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-signature"]',
  'res.headers["set-cookie"]',
  '*.email',
  '*.phone',
  '*.password',
  '*.passwordHash',
  '*.token',
];

export function loggerOptions(level: string, pretty: boolean): LoggerOptions {
  return {
    level,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
  };
}
