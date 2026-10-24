import type { LoggerOptions } from 'pino';

/**
 * PII and credentials never reach the logs. Paths cover request headers (Fastify serializers)
 * and the fields our own log calls may carry.
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
