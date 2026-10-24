import { type Queue, UnrecoverableError, Worker } from 'bullmq';
import type { Logger } from 'pino';
import type { Database } from '../../infra/prisma.js';
import { markDistributionFailed } from './distribution.repository.js';
import { distributeLead, LeadNotFoundError } from './distribution.service.js';
import type { OutboxPublisher } from './outbox-relay.js';
import {
  DISTRIBUTION_JOB,
  DISTRIBUTION_QUEUE,
  type DistributionJobData,
  distributionJobId,
} from './queue.js';

export interface DistributionWorkerOptions {
  readonly db: Database;
  readonly redisUrl: string;
  readonly concurrency: number;
  readonly logger: Logger;
}

/**
 * Consumes distribution jobs. Concurrency within and across workers is safe because
 * distributeLead serializes on Postgres row locks, not on anything in this process.
 */
export function createDistributionWorker({
  db,
  redisUrl,
  concurrency,
  logger,
}: DistributionWorkerOptions): Worker<DistributionJobData> {
  const worker = new Worker<DistributionJobData>(
    DISTRIBUTION_QUEUE,
    async (job) => {
      try {
        const outcome = await distributeLead(db, job.data.leadId);
        logger.info(
          { leadId: job.data.leadId, outcome: outcome.kind, callCenterId: outcome.callCenterId },
          'lead distribution processed',
        );
        return { kind: outcome.kind, callCenterId: outcome.callCenterId };
      } catch (error) {
        // Retrying cannot make a missing lead appear: fail now instead of after 8 attempts.
        if (error instanceof LeadNotFoundError) throw new UnrecoverableError(error.message);
        throw error;
      }
    },
    // Workers block on Redis: they need maxRetriesPerRequest = null (BullMQ requirement).
    { connection: { url: redisUrl, maxRetriesPerRequest: null }, concurrency },
  );

  worker.on('failed', (job, error) => {
    if (!job) return;
    const final =
      error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    logger.warn(
      { leadId: job.data.leadId, attempt: job.attemptsMade, final, err: error },
      'lead distribution attempt failed',
    );
    if (final) {
      markDistributionFailed(db, job.data.leadId).catch((markError: unknown) =>
        logger.error({ err: markError, leadId: job.data.leadId }, 'could not mark lead failed'),
      );
    }
  });
  worker.on('error', (error) => logger.error({ err: error }, 'distribution worker error'));

  return worker;
}

/** Outbox publisher backed by the BullMQ queue. */
export function queuePublisher(queue: Queue<DistributionJobData>): OutboxPublisher {
  return async (events) => {
    await queue.addBulk(
      events.map((event) => {
        if (event.type !== 'lead.distribution_requested') {
          throw new Error(`unsupported outbox event type "${event.type}"`);
        }
        const outboxEventId = event.id.toString();
        return {
          name: DISTRIBUTION_JOB,
          data: { leadId: event.aggregateId, outboxEventId },
          opts: { jobId: distributionJobId(event.aggregateId, outboxEventId) },
        };
      }),
    );
  };
}
