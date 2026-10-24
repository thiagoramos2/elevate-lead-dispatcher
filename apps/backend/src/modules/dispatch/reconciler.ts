import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import type { Database } from '../../infra/prisma.js';
import { DISTRIBUTION_REQUESTED } from '../leads/lead.repository.js';
import { type DistributionJobData, distributionJobId } from './queue.js';

export interface ReconcilerOptions {
  /** A pending lead older than this is inspected. Must exceed normal queue latency. */
  readonly stuckAfterSeconds?: number;
  readonly batchSize?: number;
  /** Published outbox rows older than this are deleted. */
  readonly outboxRetentionDays?: number;
}

/**
 * Safety net for the one failure the outbox cannot see: a job that was published and then
 * lost by Redis (restart without persistence, eviction, manual flush). For each lead pending
 * for too long whose latest outbox event was published, it asks BullMQ about the job; if
 * Redis no longer knows it, a new outbox event is written and the normal path takes over.
 * Jobs that are waiting, delayed, active or failed are left alone.
 */
export class DistributionReconciler {
  private readonly stuckAfterSeconds: number;
  private readonly batchSize: number;
  private readonly outboxRetentionDays: number;

  constructor(
    private readonly db: Database,
    private readonly queue: Queue<DistributionJobData>,
    private readonly logger: Logger,
    options: ReconcilerOptions = {},
  ) {
    this.stuckAfterSeconds = options.stuckAfterSeconds ?? 300;
    this.batchSize = options.batchSize ?? 200;
    this.outboxRetentionDays = options.outboxRetentionDays ?? 7;
  }

  /** Returns the number of leads re-queued. */
  async requeueLostJobs(): Promise<number> {
    const candidates = await this.db.$queryRaw<{ lead_id: string; outbox_id: bigint }[]>`
      SELECT l.id AS lead_id, o.id AS outbox_id
      FROM leads l
      CROSS JOIN LATERAL (
        SELECT id, published_at FROM outbox_events
        WHERE aggregate_id = l.id ORDER BY id DESC LIMIT 1
      ) o
      WHERE l.distribution_status = 'pending'
        AND l.created_at < now() - make_interval(secs => ${this.stuckAfterSeconds})
        AND o.published_at IS NOT NULL
      ORDER BY l.created_at
      LIMIT ${this.batchSize}`;

    let requeued = 0;
    for (const { lead_id: leadId, outbox_id: outboxId } of candidates) {
      const state = await this.queue.getJobState(distributionJobId(leadId, outboxId.toString()));
      if (state !== 'unknown') continue;
      await this.db.outboxEvent.create({
        data: { type: DISTRIBUTION_REQUESTED, aggregateId: leadId, payload: { leadId } },
      });
      requeued++;
    }
    if (requeued > 0) this.logger.warn({ requeued }, 're-queued leads whose jobs were lost');
    return requeued;
  }

  /** Keeps the outbox small: published events are only needed for a short audit window. */
  async purgePublishedOutbox(): Promise<number> {
    return this.db.$executeRaw`
      DELETE FROM outbox_events
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE published_at < now() - make_interval(days => ${this.outboxRetentionDays})
        LIMIT 5000
      )`;
  }
}
