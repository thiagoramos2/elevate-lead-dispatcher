import { type JobsOptions, Queue } from 'bullmq';

export const DISTRIBUTION_QUEUE = 'lead-distribution';
export const DISTRIBUTION_JOB = 'distribute';

export interface DistributionJobData {
  readonly leadId: string;
  readonly outboxEventId: string;
}

/**
 * Um job por evento de outbox. Se o relay cair depois de publicar mas antes de marcar o evento
 * como publicado, ele publica de novo com o mesmo id e o BullMQ ignora a duplicata enquanto o
 * primeiro job ainda estiver guardado. Um evento de reconciliação ganha um novo id de outbox,
 * então nunca é engolido por um job antigo que falhou. (O BullMQ proíbe ':' em ids customizados.)
 */
export const distributionJobId = (leadId: string, outboxEventId: string) =>
  `lead-${leadId}-o${outboxEventId}`;

export const DISTRIBUTION_JOB_OPTIONS = {
  attempts: 8,
  // 1s, 2s, 4s ... 64s: cerca de dois minutos no total, o bastante para atravessar um failover do banco.
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  // Guardado por uma semana para inspeção; o próprio lead é marcado como `failed` no Postgres.
  removeOnFail: { age: 7 * 24 * 3600 },
} as const satisfies JobsOptions;

/**
 * Producer usado pelo relay do outbox. A fila offline fica desligada para que a publicação
 * falhe rápido com o Redis fora do ar, em vez de acumular em memória: o buffer é o outbox.
 */
export function createDistributionQueue(redisUrl: string): Queue<DistributionJobData> {
  return new Queue<DistributionJobData>(DISTRIBUTION_QUEUE, {
    connection: { url: redisUrl, enableOfflineQueue: false, maxRetriesPerRequest: 1 },
    defaultJobOptions: DISTRIBUTION_JOB_OPTIONS,
  });
}
