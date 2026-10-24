import { z } from 'zod';

const MIN_WEBHOOK_SECRET_LENGTH = 32;

/** "slug:secret,slug:secret" → Map<slug, secret>. Secrets never live in the database. */
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
  APP_ORIGIN: z.url(),
  REPORTING_TIMEZONE: z.string().default('America/Sao_Paulo'),
  CALLCENTER_WEBHOOK_SECRETS: webhookSecrets.default(new Map()),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
});

export type AppConfig = z.output<typeof envSchema>;

/** Fails fast at boot with every invalid variable listed, without echoing their values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
  }
  return parsed.data;
}
