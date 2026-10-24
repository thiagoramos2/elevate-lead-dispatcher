import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/infra/prisma.js';
import {
  distributeLead,
  LeadNotFoundError,
  NoActiveCallCenterError,
} from '../../src/modules/dispatch/distribution.service.js';
import {
  connectTestDatabase,
  type Fixtures,
  resetDatabase,
  seedFixtures,
} from './setup/database.js';

describe('distributeLead (Postgres concurrency)', () => {
  // Pool larger than the number of concurrent calls, so they truly race in the database.
  const db: Database = connectTestDatabase(40);
  let fx: Fixtures;

  async function createLeads(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const lead = await db.lead.create({
        data: {
          name: `Lead ${i}`,
          email: `lead${i}@email.com`,
          phone: '+5511999999999',
          productId: fx.products.nutralean,
          funnelId: fx.funnels.nutraleanVsl,
          source: 'facebook',
          idempotencyKey: `payload:${i}`,
          requestHash: '0'.repeat(64),
        },
      });
      ids.push(lead.id);
    }
    return ids;
  }

  async function countsByCallCenter() {
    const rows = await db.distribution.groupBy({ by: ['callCenterId'], _count: true });
    const byId = new Map(rows.map((r) => [r.callCenterId, r._count]));
    return {
      a: byId.get(fx.callCenters.a) ?? 0,
      b: byId.get(fx.callCenters.b) ?? 0,
      c: byId.get(fx.callCenters.c) ?? 0,
    };
  }

  beforeEach(async () => {
    await resetDatabase(db);
    fx = await seedFixtures(db);
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('distributes 100 concurrent leads exactly 50/30/20 with a gap-free cursor', async () => {
    const leadIds = await createLeads(100);

    const outcomes = await Promise.all(leadIds.map((id) => distributeLead(db, id)));

    expect(outcomes.every((o) => o.kind === 'distributed')).toBe(true);
    expect(await countsByCallCenter()).toEqual({ a: 50, b: 30, c: 20 });

    const cursors = (await db.distribution.findMany({ select: { cursor: true } }))
      .map((d) => Number(d.cursor))
      .sort((x, y) => x - y);
    expect(cursors).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));

    const state = await db.dispatcherState.findUniqueOrThrow({ where: { id: 1 } });
    expect(state.cursor).toBe(100n);

    // The lead row and the distribution record agree for every lead.
    const mismatches = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM leads l JOIN distributions d ON d.lead_id = l.id
      WHERE l.call_center_id <> d.call_center_id OR l.distribution_status <> 'distributed'`;
    expect(mismatches[0]?.n).toBe(0n);
  });

  it('assigns each cursor value according to the SWRR schedule', async () => {
    const leadIds = await createLeads(10);
    for (const id of leadIds) await distributeLead(db, id);

    const ordered = await db.distribution.findMany({ orderBy: { cursor: 'asc' } });
    const label = new Map([
      [fx.callCenters.a, 'A'],
      [fx.callCenters.b, 'B'],
      [fx.callCenters.c, 'C'],
    ]);
    expect(ordered.map((d) => label.get(d.callCenterId)).join(' ')).toBe('A B C A A B A C B A');
  });

  it('is idempotent: the same lead processed concurrently 20 times is distributed once', async () => {
    const [leadId] = await createLeads(1);
    if (!leadId) throw new Error('lead not created');

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => distributeLead(db, leadId)),
    );

    expect(outcomes.filter((o) => o.kind === 'distributed')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'already_distributed')).toHaveLength(19);
    expect(await db.distribution.count()).toBe(1);
    // Replays do not consume cursor values.
    expect((await db.dispatcherState.findUniqueOrThrow({ where: { id: 1 } })).cursor).toBe(1n);
  });

  it('does not leave a cursor gap when no call center is active', async () => {
    const [leadId] = await createLeads(1);
    if (!leadId) throw new Error('lead not created');
    await db.callCenter.updateMany({ data: { active: false } });

    await expect(distributeLead(db, leadId)).rejects.toBeInstanceOf(NoActiveCallCenterError);

    const state = await db.dispatcherState.findUniqueOrThrow({ where: { id: 1 } });
    expect(state.cursor).toBe(0n);
    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.distributionStatus).toBe('pending');
  });

  it('skips inactive call centers', async () => {
    const leadIds = await createLeads(10);
    await db.callCenter.update({ where: { id: fx.callCenters.a }, data: { active: false } });

    for (const id of leadIds) await distributeLead(db, id);

    // B:C = 30:20 = 3:2 → 6 and 4 out of 10.
    expect(await countsByCallCenter()).toEqual({ a: 0, b: 6, c: 4 });
  });

  it('stays consistent when the configuration changes in the middle of a burst', async () => {
    const leadIds = await createLeads(60);

    // The admin transaction from ADR-0003: lock state, change weights, bump version, reset cursor.
    const changeConfig = () =>
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM dispatcher_state WHERE id = 1 FOR UPDATE`;
        await tx.callCenter.update({ where: { id: fx.callCenters.c }, data: { active: false } });
        await tx.$executeRaw`
          UPDATE dispatcher_state SET config_version = config_version + 1, cursor = 0 WHERE id = 1`;
      });

    const first = leadIds.slice(0, 30).map((id) => distributeLead(db, id));
    const change = changeConfig();
    const second = leadIds.slice(30).map((id) => distributeLead(db, id));
    await Promise.all([...first, change, ...second]);

    const distributions = await db.distribution.findMany();
    expect(distributions).toHaveLength(60);
    expect(new Set(distributions.map((d) => d.leadId)).size).toBe(60);

    // Within each configuration version the cursor is gap-free and starts at 1.
    for (const version of new Set(distributions.map((d) => d.configVersion))) {
      const cursors = distributions
        .filter((d) => d.configVersion === version)
        .map((d) => Number(d.cursor))
        .sort((x, y) => x - y);
      expect(cursors).toEqual(Array.from({ length: cursors.length }, (_, i) => i + 1));
    }
    // After the change, C (deactivated) never receives a lead.
    const afterChange = distributions.filter((d) => d.configVersion === 2);
    expect(afterChange.some((d) => d.callCenterId === fx.callCenters.c)).toBe(false);
  });

  it('rejects an unknown lead as unrecoverable', async () => {
    await expect(distributeLead(db, crypto.randomUUID())).rejects.toBeInstanceOf(LeadNotFoundError);
  });
});
