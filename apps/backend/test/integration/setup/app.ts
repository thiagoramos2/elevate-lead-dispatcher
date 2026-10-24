import { inject } from 'vitest';
import { type App, buildApp } from '../../../src/app.js';
import { loadConfig } from '../../../src/config/env.js';
import type { Database } from '../../../src/infra/prisma.js';

export const WEBHOOK_SECRETS = {
  'callcenter-a': 'test-secret-a-0123456789abcdef0123456789',
  'callcenter-b': 'test-secret-b-0123456789abcdef0123456789',
  'callcenter-c': 'test-secret-c-0123456789abcdef0123456789',
} as const;

export function testConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: inject('databaseUrl'),
    REDIS_URL: inject('redisUrl'),
    CALLCENTER_WEBHOOK_SECRETS: Object.entries(WEBHOOK_SECRETS)
      .map(([slug, secret]) => `${slug}:${secret}`)
      .join(','),
  });
}

export function buildTestApp(db: Database): Promise<App> {
  return buildApp({ config: testConfig(), db });
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
