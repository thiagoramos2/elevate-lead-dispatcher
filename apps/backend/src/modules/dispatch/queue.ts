import { type JobsOptions, Queue } from 'bullmq';

export const DISTRIBUTION_QUEUE = 'lead-distribution';
export const DISTRIBUTION_JOB = 'distribute';

export interface DistributionJobData {
  readonly leadId: string;
  readonly outboxEventId: string;
}

/**
 * One job per outbox event. If the relay crashes after publishing but before marking the
 * event as published, it publishes again with the same id and BullMQ ignores the duplicate
 * while the first job is still stored. A reconciliation event gets a new outbox id, so it
 * is never swallowed by an old failed job. (BullMQ forbids ':' in custom ids.)
 */
export const distributionJobId = (leadId: string, outboxEventId: string) =>
  `lead-${leadId}-o${outboxEventId}`;

export const DISTRIBUTION_JOB_OPTIONS = {
  attempts: 8,
  // 1s, 2s, 4s ... 64s: about two minutes in total, enough to ride out a database failover.
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  // Kept for a week for inspection; the lead itself is marked `failed` in Postgres.
  removeOnFail: { age: 7 * 24 * 3600 },
} as const satisfies JobsOptions;

/**
 * Producer used by the outbox relay. The offline queue is disabled so that publishing fails
 * fast while Redis is down, instead of buffering in memory: the outbox is the buffer.
 */
export function createDistributionQueue(redisUrl: string): Queue<DistributionJobData> {
  return new Queue<DistributionJobData>(DISTRIBUTION_QUEUE, {
    connection: { url: redisUrl, enableOfflineQueue: false, maxRetriesPerRequest: 1 },
    defaultJobOptions: DISTRIBUTION_JOB_OPTIONS,
  });
}
