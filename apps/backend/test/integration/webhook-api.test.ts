import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import type { Database } from '../../src/infra/prisma.js';
import { distributeLead } from '../../src/modules/dispatch/distribution.service.js';
import { signPayload } from '../../src/modules/webhooks/signature.js';
import { buildTestApp, validLead, WEBHOOK_SECRETS } from './setup/app.js';
import { connectTestDatabase, resetDatabase, seedFixtures } from './setup/database.js';

type Slug = keyof typeof WEBHOOK_SECRETS;

describe('POST /api/webhooks/callcenter', () => {
  const db: Database = connectTestDatabase();
  let app: App;
  let leadId: string;

  /** Assina o corpo exatamente como o call center faria e envia. */
  const send = (
    body: Record<string, unknown>,
    options: { slug?: Slug; secret?: string; signedAt?: number; signature?: string } = {},
  ) => {
    const slug = options.slug ?? 'callcenter-a';
    const raw = JSON.stringify(body);
    const signature =
      options.signature ??
      signPayload(
        options.secret ?? WEBHOOK_SECRETS[slug],
        raw,
        options.signedAt ?? Math.floor(Date.now() / 1000),
      );
    return app.inject({
      method: 'POST',
      url: '/api/webhooks/callcenter',
      payload: raw,
      headers: {
        'content-type': 'application/json',
        'x-callcenter-id': slug,
        'x-signature': signature,
      },
    });
  };

  const event = (status: string, timestamp: string, extra: Record<string, unknown> = {}) => ({
    lead_id: leadId,
    external_id: 'abc123',
    status,
    timestamp,
    ...extra,
  });

  const lead = () => db.lead.findUniqueOrThrow({ where: { id: leadId } });
  const history = () =>
    db.leadEvent.findMany({ where: { leadId, origin: 'webhook' }, orderBy: { receivedAt: 'asc' } });

  beforeAll(async () => {
    app = await buildTestApp(db);
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await seedFixtures(db);
    // Lead criado pela API e distribuído: cursor 1 → posição 1 do escalonamento → Call Center A.
    leadId = (await app.inject({ method: 'POST', url: '/api/leads', payload: validLead() })).json()
      .lead_id;
    await distributeLead(db, leadId);
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  describe('status updates', () => {
    it('applies a valid event, updates the lead and records it for auditing', async () => {
      const fresh = await send(event('contacted', new Date().toISOString()));
      expect(fresh.statusCode).toBe(200);
      expect(fresh.json()).toEqual({
        success: true,
        duplicate: false,
        applied: true,
        status: 'contacted',
      });

      expect((await lead()).status).toBe('contacted');
      const events = await history();
      expect(events.at(-1)).toMatchObject({
        fromStatus: 'new',
        toStatus: 'contacted',
        applied: true,
        externalId: 'abc123',
        payload: expect.objectContaining({ status: 'contacted' }),
      });
    });

    it('treats the same webhook received again as a duplicate without side effects', async () => {
      const body = event('contacted', new Date().toISOString());
      const first = await send(body);
      const again = await send(body);

      expect(first.json()).toMatchObject({ duplicate: false, applied: true });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ duplicate: true, applied: false, status: 'contacted' });
      expect(await history()).toHaveLength(1);
    });

    it('treats the same instant written with another offset as the same event', async () => {
      const at = new Date(Date.now() + 1000);
      await send(event('contacted', at.toISOString()));
      const sameInstant = at.toISOString().replace('Z', '+00:00');
      expect((await send(event('contacted', sameInstant))).json().duplicate).toBe(true);
    });

    it('records but does not apply a contacted event that happened before an applied sale', async () => {
      const t0 = Date.now();
      const sale = await send(event('sale', new Date(t0 + 2000).toISOString()));
      const lateContacted = await send(event('contacted', new Date(t0 + 1000).toISOString()));

      expect(sale.json()).toMatchObject({ applied: true, status: 'sale' });
      expect(lateContacted.statusCode).toBe(200);
      expect(lateContacted.json()).toEqual({
        success: true,
        duplicate: false,
        applied: false,
        reason: 'stale',
        status: 'sale',
      });
      expect((await lead()).status).toBe('sale');
      expect((await history()).map((e) => [e.toStatus, e.applied, e.rejectionReason])).toEqual([
        ['sale', true, null],
        ['contacted', false, 'stale'],
      ]);
    });

    it('rejects a newer event whose transition is not allowed (sale → contacted)', async () => {
      const t0 = Date.now();
      await send(event('sale', new Date(t0 + 1000).toISOString()));
      const response = await send(event('contacted', new Date(t0 + 2000).toISOString()));
      expect(response.json()).toMatchObject({
        applied: false,
        reason: 'invalid_transition',
        status: 'sale',
      });
      expect((await lead()).status).toBe('sale');
    });

    it('allows a refund after a sale', async () => {
      const t0 = Date.now();
      await send(event('sale', new Date(t0 + 1000).toISOString()));
      const refund = await send(event('refund', new Date(t0 + 2000).toISOString()));
      expect(refund.json()).toMatchObject({ applied: true, status: 'refund' });
    });

    it('applies only the newest of concurrent events and records each exactly once', async () => {
      const t0 = Date.now();
      const statuses = ['contacted', 'callback', 'no_answer', 'qualified', 'sale'];
      const bodies = statuses.map((status, i) =>
        event(status, new Date(t0 + 1000 * (i + 1)).toISOString()),
      );
      // Cada evento enviado 3 vezes, tudo ao mesmo tempo e em ordem embaralhada.
      const burst = [...bodies, ...bodies, ...bodies].sort(() => Math.random() - 0.5);

      const responses = await Promise.all(burst.map((body) => send(body)));

      expect(responses.every((r) => r.statusCode === 200)).toBe(true);
      expect(await history()).toHaveLength(5);
      // O mais novo vence sempre que chegar; um evento mais antigo nunca sobrescreve um mais novo.
      const final = await lead();
      expect(final.statusChangedAt.getTime()).toBe(
        Math.max(...(await history()).filter((e) => e.applied).map((e) => e.occurredAt.getTime())),
      );
      expect(['sale', 'qualified', 'no_answer', 'callback', 'contacted']).toContain(final.status);
    });
  });

  describe('security', () => {
    it.each([
      [
        'a signature made with the wrong secret',
        { secret: 'wrong-secret-0123456789abcdef0123456789' },
      ],
      ['an expired signature (replay)', { signedAt: Math.floor(Date.now() / 1000) - 3600 }],
      ['a malformed signature header', { signature: 'not-a-signature' }],
    ])('rejects %s with 401 and records nothing', async (_label, options) => {
      const response = await send(event('sale', new Date().toISOString()), options);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('INVALID_SIGNATURE');
      expect(await history()).toHaveLength(0);
      expect((await lead()).status).toBe('new');
    });

    it('rejects a body changed after signing', async () => {
      const body = event('contacted', new Date().toISOString());
      const signature = signPayload(
        WEBHOOK_SECRETS['callcenter-a'],
        JSON.stringify(body),
        Math.floor(Date.now() / 1000),
      );
      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/callcenter',
        payload: JSON.stringify({ ...body, status: 'sale' }),
        headers: {
          'content-type': 'application/json',
          'x-callcenter-id': 'callcenter-a',
          'x-signature': signature,
        },
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects requests without authentication headers or from an unknown call center', async () => {
      const noHeaders = await app.inject({
        method: 'POST',
        url: '/api/webhooks/callcenter',
        payload: event('sale', new Date().toISOString()),
      });
      expect(noHeaders.statusCode).toBe(401);

      const unknown = await app.inject({
        method: 'POST',
        url: '/api/webhooks/callcenter',
        payload: event('sale', new Date().toISOString()),
        headers: { 'x-callcenter-id': 'callcenter-z', 'x-signature': 't=1,v1=00' },
      });
      expect(unknown.statusCode).toBe(401);
    });

    it('does not reveal validation details to unauthenticated callers', async () => {
      const response = await send({ lead_id: 'not-a-uuid' }, { signature: 'nope' });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.details).toBeUndefined();
    });

    it('answers 404 when a call center updates a lead distributed to another one', async () => {
      const response = await send(event('sale', new Date().toISOString()), {
        slug: 'callcenter-b',
      });
      expect(response.statusCode).toBe(404);
      expect((await lead()).status).toBe('new');
      expect(await history()).toHaveLength(0);
    });

    it("answers 404 for an unknown lead, indistinguishable from another call center's lead", async () => {
      const response = await send(
        event('sale', new Date().toISOString(), { lead_id: crypto.randomUUID() }),
      );
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    });
  });

  describe('validation', () => {
    it('returns 400 for an unknown status or a malformed payload from an authenticated caller', async () => {
      const response = await send(event('won', new Date().toISOString()));
      expect(response.statusCode).toBe(400);
      expect(response.json().error.details[0].path).toBe('status');

      const missing = await send({ lead_id: leadId });
      expect(missing.statusCode).toBe(400);
    });

    it('returns 422 for an event timestamp in the future', async () => {
      const response = await send(event('sale', new Date(Date.now() + 3600_000).toISOString()));
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('TIMESTAMP_IN_FUTURE');
    });
  });
});
