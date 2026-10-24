import { setTimeout as sleep } from 'node:timers/promises';
import type { Queue, Worker } from 'bullmq';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { App } from '../../src/app.js';
import type { Database } from '../../src/infra/prisma.js';
import {
  createDistributionWorker,
  queuePublisher,
} from '../../src/modules/dispatch/distribution-worker.js';
import { OutboxRelay } from '../../src/modules/dispatch/outbox-relay.js';
import {
  createDistributionQueue,
  DISTRIBUTION_JOB,
  type DistributionJobData,
} from '../../src/modules/dispatch/queue.js';
import { DistributionReconciler } from '../../src/modules/dispatch/reconciler.js';
import { buildTestApp, validLead } from './setup/app.js';
import {
  connectTestDatabase,
  type Fixtures,
  resetDatabase,
  seedFixtures,
} from './setup/database.js';

const silent = pino({ level: 'silent' });

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(50);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

/**
 * End-to-end through real infrastructure: HTTP → Postgres (lead + outbox) → relay → Redis
 * (BullMQ) → several concurrent workers → Postgres (distribution).
 */
describe('distribution pipeline', () => {
  const db: Database = connectTestDatabase(40);
  const redisUrl = inject('redisUrl');
  let fx: Fixtures;
  let app: App;
  let queue: Queue<DistributionJobData>;
  let workers: Worker<DistributionJobData>[] = [];

  const startWorkers = (count: number, concurrency: number) => {
    workers = Array.from({ length: count }, () =>
      createDistributionWorker({ db, redisUrl, concurrency, logger: silent }),
    );
  };

  const distributedCount = () => db.lead.count({ where: { distributionStatus: 'distributed' } });

  const idle = async () => {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
    return Object.values(counts).every((n) => n === 0);
  };

  beforeAll(async () => {
    app = await buildTestApp(db);
    await app.listen({ host: '127.0.0.1', port: 0 });
    queue = createDistributionQueue(redisUrl);
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await resetDatabase(db);
    fx = await seedFixtures(db);
  });

  afterEach(async () => {
    await Promise.all(workers.map((w) => w.close()));
    workers = [];
  });

  afterAll(async () => {
    await queue.close();
    await app.close();
    await db.$disconnect();
  });

  it('distributes 100 simultaneous HTTP leads 50/30/20 across 4 concurrent workers', async () => {
    const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/leads`;

    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(validLead()),
        }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(100).fill(201));

    // Workers first, relay second: jobs are consumed while they are still being published.
    startWorkers(4, 10);
    const relay = new OutboxRelay(db, queuePublisher(queue), silent);
    expect(await relay.drain()).toBe(100);

    await waitFor(async () => (await distributedCount()) === 100);

    // No lost lead, no duplicate distribution, referential consistency.
    expect(await db.lead.count()).toBe(100);
    expect(await db.distribution.count()).toBe(100);
    expect(await db.outboxEvent.count({ where: { publishedAt: null } })).toBe(0);

    // Exact weighted split and a gap-free cursor, despite 40 concurrent consumers.
    const byCenter = await db.distribution.groupBy({ by: ['callCenterId'], _count: true });
    const count = (id: string) => byCenter.find((r) => r.callCenterId === id)?._count;
    expect([count(fx.callCenters.a), count(fx.callCenters.b), count(fx.callCenters.c)]).toEqual([
      50, 30, 20,
    ]);
    const cursors = (await db.distribution.findMany({ select: { cursor: true } }))
      .map((d) => Number(d.cursor))
      .sort((x, y) => x - y);
    expect(cursors).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });

  it('ignores reprocessing: delivering every job again creates no new distribution', async () => {
    for (let i = 0; i < 20; i++)
      await app.inject({ method: 'POST', url: '/api/leads', payload: validLead() });
    startWorkers(2, 5);
    await new OutboxRelay(db, queuePublisher(queue), silent).drain();
    await waitFor(async () => (await distributedCount()) === 20);

    // Simulate duplicate delivery of every lead with brand new job ids.
    const leads = await db.lead.findMany({ select: { id: true } });
    await queue.addBulk(
      leads.map((l) => ({
        name: DISTRIBUTION_JOB,
        data: { leadId: l.id, outboxEventId: 'replay' },
        opts: { jobId: `replay-${l.id}` },
      })),
    );
    await waitFor(idle);

    expect(await db.distribution.count()).toBe(20);
    expect((await db.dispatcherState.findUniqueOrThrow({ where: { id: 1 } })).cursor).toBe(20n);
  });

  it('keeps events in the outbox while the transport is down and publishes them later', async () => {
    for (let i = 0; i < 5; i++)
      await app.inject({ method: 'POST', url: '/api/leads', payload: validLead() });

    const down = new OutboxRelay(
      db,
      async () => {
        throw new Error('ECONNREFUSED redis');
      },
      silent,
    );
    expect(await down.publishBatch()).toBe(0);

    const pending = await db.outboxEvent.findMany();
    expect(pending.every((e) => e.publishedAt === null && e.attempts === 1)).toBe(true);
    expect(pending.every((e) => e.lastError?.includes('ECONNREFUSED'))).toBe(true);
    expect(pending.every((e) => e.availableAt.getTime() > Date.now())).toBe(true);
    // Backed off: not retried immediately.
    expect(await down.publishBatch()).toBe(0);
    expect((await db.outboxEvent.findFirstOrThrow()).attempts).toBe(1);

    // Transport is back and the backoff elapsed.
    await db.$executeRaw`UPDATE outbox_events SET available_at = now()`;
    startWorkers(1, 5);
    expect(await new OutboxRelay(db, queuePublisher(queue), silent).drain()).toBe(5);
    await waitFor(async () => (await distributedCount()) === 5);
  });

  it('publishes each event once even with several relays running concurrently', async () => {
    for (let i = 0; i < 60; i++)
      await app.inject({ method: 'POST', url: '/api/leads', payload: validLead() });
    const published: bigint[] = [];
    const recording = new OutboxRelay(
      db,
      async (events) => {
        published.push(...events.map((e) => e.id));
        await queuePublisher(queue)(events);
      },
      silent,
      { batchSize: 7 },
    );

    const totals = await Promise.all([recording.drain(), recording.drain(), recording.drain()]);

    expect(totals.reduce((a, b) => a + b, 0)).toBe(60);
    expect(new Set(published.map(String)).size).toBe(60);
    expect(published).toHaveLength(60);
  });

  it('deduplicates a re-publication of the same outbox event (relay crash before commit)', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: validLead() });
    const [event] = await db.$queryRaw<{ id: bigint; type: string; aggregate_id: string }[]>`
      SELECT id, type, aggregate_id FROM outbox_events`;
    if (!event) throw new Error('no outbox event');
    const publish = queuePublisher(queue);
    const pendingEvent = { id: event.id, type: event.type, aggregateId: event.aggregate_id };

    await publish([pendingEvent]);
    await publish([pendingEvent]);

    expect(await queue.getJobCountByTypes('waiting')).toBe(1);
  });

  it('retries a transient failure and marks the lead failed when retries are exhausted', async () => {
    const { lead_id: leadId } = (
      await app.inject({ method: 'POST', url: '/api/leads', payload: validLead() })
    ).json();
    await db.callCenter.updateMany({ data: { active: false } });

    startWorkers(1, 1);
    await queue.add(
      DISTRIBUTION_JOB,
      { leadId, outboxEventId: '1' },
      { attempts: 3, backoff: { type: 'fixed', delay: 50 } },
    );

    await waitFor(async () => {
      const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
      return lead.distributionStatus === 'failed';
    });
    const [failed] = await queue.getFailed();
    expect(failed?.attemptsMade).toBe(3);
    expect((await db.dispatcherState.findUniqueOrThrow({ where: { id: 1 } })).cursor).toBe(0n);
  });

  it('fails a job for an unknown lead immediately, without retries', async () => {
    startWorkers(1, 1);
    await queue.add(DISTRIBUTION_JOB, { leadId: crypto.randomUUID(), outboxEventId: '1' });
    await waitFor(async () => (await queue.getJobCountByTypes('failed')) === 1);
    const [failed] = await queue.getFailed();
    expect(failed?.attemptsMade).toBe(1);
  });

  it('re-queues a lead whose published job was lost by Redis', async () => {
    const { lead_id: leadId } = (
      await app.inject({ method: 'POST', url: '/api/leads', payload: validLead() })
    ).json();
    // Published, then lost: marked published in Postgres but never present in Redis.
    await db.$executeRaw`UPDATE outbox_events SET published_at = now()`;
    await db.$executeRaw`UPDATE leads SET created_at = now() - interval '10 minutes'`;

    const reconciler = new DistributionReconciler(db, queue, silent, { stuckAfterSeconds: 300 });
    expect(await reconciler.requeueLostJobs()).toBe(1);
    // Idempotent while the new event is still unpublished.
    expect(await reconciler.requeueLostJobs()).toBe(0);

    startWorkers(1, 1);
    await new OutboxRelay(db, queuePublisher(queue), silent).drain();
    await waitFor(async () => {
      const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
      return lead.distributionStatus === 'distributed';
    });
  });

  it('leaves recent pending leads and live jobs alone', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: validLead() });
    await new OutboxRelay(db, queuePublisher(queue), silent).drain(); // job waiting, no worker
    await db.$executeRaw`UPDATE leads SET created_at = now() - interval '10 minutes'`;

    const reconciler = new DistributionReconciler(db, queue, silent, { stuckAfterSeconds: 300 });
    expect(await reconciler.requeueLostJobs()).toBe(0);
    expect(await db.outboxEvent.count()).toBe(1);
  });
});
