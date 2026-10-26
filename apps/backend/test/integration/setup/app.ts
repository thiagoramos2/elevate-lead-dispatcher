import { inject } from 'vitest';
import { type App, buildApp } from '../../../src/app.js';
import { loadConfig } from '../../../src/config/env.js';
import type { Database } from '../../../src/infra/prisma.js';

export const WEBHOOK_SECRETS = {
  'callcenter-a': 'test-secret-a-0123456789abcdef0123456789',
  'callcenter-b': 'test-secret-b-0123456789abcdef0123456789',
  'callcenter-c': 'test-secret-c-0123456789abcdef0123456789',
} as const;

export function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    APP_ORIGIN: 'http://localhost:3000',
    // Alto por padrão para os testes não interferirem entre si; o teste de rate limit usa um app próprio.
    RATE_LIMIT_LOGIN_PER_MINUTE: '1000',
    ...overrides,
    DATABASE_URL: inject('databaseUrl'),
    REDIS_URL: inject('redisUrl'),
    CALLCENTER_WEBHOOK_SECRETS: Object.entries(WEBHOOK_SECRETS)
      .map(([slug, secret]) => `${slug}:${secret}`)
      .join(','),
  });
}

export function buildTestApp(db: Database, overrides: Record<string, string> = {}): Promise<App> {
  return buildApp({ config: testConfig(overrides), db });
}

export const validLead = (overrides: Record<string, unknown> = {}) => ({
  name: 'João Silva',
  email: `lead-${crypto.randomUUID()}@email.com`,
  phone: '+5511999999999',
  product: 'nutralean',
  funnel: 'vsl-01',
  source: 'facebook',
  campaign: 'campaign-123',
  affiliate_id: '999',
  utm: { source: 'facebook', medium: 'cpc', campaign: 'campaign-123', content: 'ad-01' },
  ...overrides,
});
