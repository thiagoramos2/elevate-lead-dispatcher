import { createLeadSchema } from '@elevate/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import type { Database } from '../../src/infra/prisma.js';
import { createLead } from '../../src/modules/leads/lead.service.js';
import { buildTestApp, validLead } from './setup/app.js';
import {
  connectTestDatabase,
  type Fixtures,
  resetDatabase,
  seedFixtures,
} from './setup/database.js';

describe('POST /api/leads', () => {
  const db: Database = connectTestDatabase();
  let app: App;
  let fx: Fixtures;

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/leads', payload: body as object, headers });

  beforeAll(async () => {
    app = await buildTestApp(db);
  });

  beforeEach(async () => {
    await resetDatabase(db);
    fx = await seedFixtures(db);
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  describe('creation', () => {
    it('stores the lead with product, funnel, tracking data and a pending distribution', async () => {
      const response = await post(validLead({ email: 'Joao@Email.com' }));

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toEqual({
        success: true,
        lead_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        duplicate: false,
        distribution_status: 'pending',
      });

      const lead = await db.lead.findUniqueOrThrow({
        where: { id: body.lead_id },
        include: { affiliate: true, events: true },
      });
      expect(lead).toMatchObject({
        email: 'joao@email.com',
        phone: '+5511999999999',
        productId: fx.products.nutralean,
        funnelId: fx.funnels.nutraleanVsl,
        source: 'facebook',
        campaign: 'campaign-123',
        utmSource: 'facebook',
        utmMedium: 'cpc',
        utmCampaign: 'campaign-123',
        utmContent: 'ad-01',
        utmTerm: null,
        status: 'new',
        distributionStatus: 'pending',
        callCenterId: null,
      });
      expect(lead.createdAt).toBeInstanceOf(Date);
      expect(lead.affiliate?.externalRef).toBe('999');
      expect(lead.events).toHaveLength(1);
      expect(lead.events[0]).toMatchObject({ origin: 'system', toStatus: 'new', applied: true });
    });

    it('writes exactly one outbox event in the same transaction as the lead', async () => {
      const { lead_id } = (await post(validLead())).json();
      const events = await db.outboxEvent.findMany({ where: { aggregateId: lead_id } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'lead.distribution_requested',
        payload: { leadId: lead_id },
        publishedAt: null,
      });
    });

    it('reuses an existing affiliate instead of duplicating it', async () => {
      await post(validLead({ affiliate_id: 'aff-1' }));
      await post(validLead({ affiliate_id: 'aff-1' }));
      expect(await db.affiliate.count({ where: { externalRef: 'aff-1' } })).toBe(1);
    });

    it('falls back to the UTM source, then to "direct", when source is absent', async () => {
      const { source: _s, ...withoutSource } = validLead();
      const fromUtm = (await post(withoutSource)).json();
      const { utm: _u, ...bare } = withoutSource;
      const direct = (await post(bare)).json();

      const leads = await db.lead.findMany({
        where: { id: { in: [fromUtm.lead_id, direct.lead_id] } },
      });
      expect(leads.find((l) => l.id === fromUtm.lead_id)?.source).toBe('facebook');
      expect(leads.find((l) => l.id === direct.lead_id)?.source).toBe('direct');
    });
  });

  describe('validation', () => {
    it('returns 400 with per-field details for malformed input', async () => {
      const response = await post(validLead({ name: '', email: 'nope', phone: '123' }));
      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      const paths = body.error.details.map((d: { path: string }) => d.path);
      expect(paths).toEqual(expect.arrayContaining(['name', 'email', 'phone']));
    });

    it('returns 400 for wrong types and a malformed UTM object', async () => {
      const response = await post(validLead({ affiliate_id: 999, utm: { source: 1, foo: 'x' } }));
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 for a body that is not JSON', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/leads',
        payload: '{"name":',
        headers: { 'content-type': 'application/json' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().success).toBe(false);
    });

    it('returns 422 for an unknown product', async () => {
      const response = await post(validLead({ product: 'does-not-exist' }));
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('UNKNOWN_PRODUCT');
    });

    it('returns 422 for a funnel that belongs to another product', async () => {
      const response = await post(validLead({ product: 'glucoshield', funnel: 'quiz-99' }));
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('INVALID_FUNNEL');
    });

    it('returns 422 for an inactive funnel', async () => {
      await db.funnel.update({ where: { id: fx.funnels.nutraleanVsl }, data: { active: false } });
      const response = await post(validLead());
      expect(response.statusCode).toBe(422);
    });

    it('never echoes internals on error', async () => {
      const response = await post(validLead({ email: 'nope' }));
      expect(response.body).not.toMatch(/prisma|stack|at \w+ \(/i);
    });
  });

  describe('idempotency', () => {
    it('returns the original lead with 200 when the same payload is retried', async () => {
      const payload = validLead();
      const first = await post(payload);
      const retry = await post(payload);

      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ lead_id: first.json().lead_id, duplicate: true });
      expect(await db.lead.count()).toBe(1);
      expect(await db.outboxEvent.count()).toBe(1);
    });

    it('treats differently formatted but equivalent payloads as the same request', async () => {
      const payload = validLead();
      const first = await post(payload);
      const retry = await post({
        ...payload,
        email: payload.email.toUpperCase(),
        name: `  ${payload.name}  `,
        phone: '+55 11 99999-9999',
      });
      expect(retry.json().lead_id).toBe(first.json().lead_id);
    });

    it('creates a new lead when the same payload arrives on another day', async () => {
      const payload = createLeadSchema.parse(validLead());
      const today = await createLead(db, payload, undefined, new Date('2026-10-24T10:00:00Z'));
      const retry = await createLead(db, payload, undefined, new Date('2026-10-24T23:00:00Z'));
      const nextWeek = await createLead(db, payload, undefined, new Date('2026-10-31T10:00:00Z'));

      expect(retry).toMatchObject({ leadId: today.leadId, duplicate: true });
      expect(nextWeek.duplicate).toBe(false);
      expect(nextWeek.leadId).not.toBe(today.leadId);
      expect(await db.lead.count()).toBe(2);
    });

    it('honours an explicit Idempotency-Key', async () => {
      const key = { 'idempotency-key': 'order-abc-123' };
      const payload = validLead();
      const first = await post(payload, key);
      const retry = await post(payload, key);
      expect(retry.statusCode).toBe(200);
      expect(retry.json().lead_id).toBe(first.json().lead_id);
    });

    it('creates distinct leads for identical payloads sent with distinct Idempotency-Keys', async () => {
      const payload = validLead();
      await post(payload, { 'idempotency-key': 'submission-0001' });
      await post(payload, { 'idempotency-key': 'submission-0002' });
      expect(await db.lead.count()).toBe(2);
    });

    it('returns 409 when an Idempotency-Key is reused with a different payload', async () => {
      const key = { 'idempotency-key': 'order-abc-123' };
      await post(validLead(), key);
      const reused = await post(validLead(), key);
      expect(reused.statusCode).toBe(409);
      expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await db.lead.count()).toBe(1);
    });

    it('rejects a malformed Idempotency-Key', async () => {
      const response = await post(validLead(), { 'idempotency-key': 'short' });
      expect(response.statusCode).toBe(400);
    });

    it('creates exactly one lead when the same request arrives 25 times concurrently', async () => {
      const payload = validLead();
      const responses = await Promise.all(Array.from({ length: 25 }, () => post(payload)));

      const statuses = responses.map((r) => r.statusCode).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 200)).toHaveLength(24);
      expect(new Set(responses.map((r) => r.json().lead_id)).size).toBe(1);
      expect(await db.lead.count()).toBe(1);
      expect(await db.outboxEvent.count()).toBe(1);
      expect(await db.leadEvent.count()).toBe(1);
    });
  });
});
