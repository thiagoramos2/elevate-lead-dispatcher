import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/infra/prisma.js';
import {
  connectTestDatabase,
  type Fixtures,
  resetDatabase,
  seedFixtures,
} from './setup/database.js';

/**
 * The database is the last line of defence. These tests prove the invariants hold even if
 * application code is wrong, by writing invalid rows directly.
 */
describe('schema constraints', () => {
  const db: Database = connectTestDatabase();
  let fx: Fixtures;

  const leadData = (overrides: Record<string, unknown> = {}) => ({
    name: 'João Silva',
    email: 'joao@email.com',
    phone: '+5511999999999',
    productId: fx.products.nutralean,
    funnelId: fx.funnels.nutraleanVsl,
    source: 'facebook',
    idempotencyKey: `payload:${crypto.randomUUID()}`,
    requestHash: 'a'.repeat(64),
    ...overrides,
  });

  beforeEach(async () => {
    await resetDatabase(db);
    fx = await seedFixtures(db);
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('generates time-ordered uuidv7 ids and creation timestamps', async () => {
    const first = await db.lead.create({ data: leadData() });
    const second = await db.lead.create({ data: leadData() });
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(second.id > first.id).toBe(true);
    expect(first.createdAt).toBeInstanceOf(Date);
    expect(first.status).toBe('new');
    expect(first.distributionStatus).toBe('pending');
  });

  it('rejects a lead whose funnel belongs to another product (composite FK)', async () => {
    await expect(
      db.lead.create({ data: leadData({ funnelId: fx.funnels.glucoshieldVsl }) }),
    ).rejects.toThrow();
  });

  it('rejects two leads with the same idempotency key', async () => {
    const data = leadData();
    await db.lead.create({ data });
    await expect(db.lead.create({ data: { ...data } })).rejects.toThrow();
  });

  it('rejects a lead marked distributed without a call center', async () => {
    await expect(
      db.lead.create({ data: leadData({ distributionStatus: 'distributed' }) }),
    ).rejects.toThrow();
  });

  it('allows a single distribution per lead', async () => {
    const lead = await db.lead.create({ data: leadData() });
    const distribution = {
      leadId: lead.id,
      callCenterId: fx.callCenters.a,
      cursor: 1n,
      configVersion: 1,
    };
    await db.distribution.create({ data: distribution });
    await expect(
      db.distribution.create({
        data: { ...distribution, callCenterId: fx.callCenters.b, cursor: 2n },
      }),
    ).rejects.toThrow();
  });

  it('keeps dispatcher_state as a single row', async () => {
    await expect(db.$executeRaw`INSERT INTO dispatcher_state (id) VALUES (2)`).rejects.toThrow();
  });

  it('rejects non-positive call center weights', async () => {
    await expect(
      db.callCenter.create({ data: { slug: 'zero', name: 'Zero', weight: 0 } }),
    ).rejects.toThrow();
  });

  it('requires a call center for operators and forbids it for admins', async () => {
    await expect(
      db.user.create({ data: { email: 'op@x.local', passwordHash: 'x', role: 'operator' } }),
    ).rejects.toThrow();
    await expect(
      db.user.create({
        data: {
          email: 'ad@x.local',
          passwordHash: 'x',
          role: 'admin',
          callCenterId: fx.callCenters.a,
        },
      }),
    ).rejects.toThrow();
  });

  it('requires a rejection reason exactly when an event is not applied', async () => {
    const lead = await db.lead.create({ data: leadData() });
    const event = {
      leadId: lead.id,
      origin: 'webhook' as const,
      dedupKey: 'b'.repeat(64),
      toStatus: 'contacted' as const,
      occurredAt: new Date(),
    };
    await expect(db.leadEvent.create({ data: { ...event, applied: false } })).rejects.toThrow();
    await expect(
      db.leadEvent.create({ data: { ...event, applied: true, rejectionReason: 'stale' } }),
    ).rejects.toThrow();
  });
});
