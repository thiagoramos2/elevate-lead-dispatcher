import { z } from 'zod';

const MIN_WEBHOOK_SECRET_LENGTH = 32;

/** "slug:segredo,slug:segredo" → Map<slug, segredo>. Os segredos nunca ficam no banco. */
const webhookSecrets = z.string().transform((raw, ctx) => {
  const secrets = new Map<string, string>();
  for (const pair of raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const separator = pair.indexOf(':');
    const slug = pair.slice(0, separator).trim();
    const secret = pair.slice(separator + 1).trim();
    if (separator <= 0 || secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        message: `each entry must be "slug:secret" with a secret of at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`,
      });
      return z.NEVER;
    }
    secrets.set(slug, secret);
  }
  return secrets;
});

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  APP_ORIGIN: z.url().default('http://localhost:3000'),
  /** Quantidade de proxies reversos na frente da API cujo X-Forwarded-For é confiável. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  REPORTING_TIMEZONE: z.string().default('America/Sao_Paulo'),
  CALLCENTER_WEBHOOK_SECRETS: webhookSecrets.default(new Map()),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  /**
   * Cookie de sessão com `Secure`. Padrão: ligado em produção. O Compose de demonstração roda em
   * http://localhost e o desliga explicitamente; atrás de HTTPS deve ficar ligado.
   */
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(72).default(8),
  RATE_LIMIT_LOGIN_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_LEADS_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_WEBHOOK_PER_MINUTE: z.coerce.number().int().min(1).default(1200),
});

export type AppConfig = z.output<typeof envSchema>;

/** Falha já na inicialização listando todas as variáveis inválidas, sem exibir os valores. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
  }
  return parsed.data;
}

export function cookieSecure(config: AppConfig): boolean {
  return config.COOKIE_SECURE === undefined
    ? config.NODE_ENV === 'production'
    : config.COOKIE_SECURE === 'true';
}
