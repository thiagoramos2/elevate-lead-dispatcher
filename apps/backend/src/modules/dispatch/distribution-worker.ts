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
 * Consome os jobs de distribuição. A concorrência dentro de um worker e entre workers é segura
 * porque distributeLead serializa em row locks do Postgres, não em nada deste processo.
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
        // Retentar não faz um lead inexistente aparecer: falha agora em vez de depois de 8 tentativas.
        if (error instanceof LeadNotFoundError) throw new UnrecoverableError(error.message);
        throw error;
      }
    },
    // Workers ficam bloqueados no Redis: precisam de maxRetriesPerRequest = null (exigência do BullMQ).
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

/** Publisher do outbox que usa a fila do BullMQ. */
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
