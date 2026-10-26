import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import type { Database } from '../../infra/prisma.js';
import { DISTRIBUTION_REQUESTED } from '../leads/lead.repository.js';
import { markDistributionFailed } from './distribution.repository.js';
import { type DistributionJobData, distributionJobId } from './queue.js';

export interface ReconcilerOptions {
  /** Um lead pendente mais antigo que isto é inspecionado. Precisa ser maior que a latência normal da fila. */
  readonly stuckAfterSeconds?: number;
  readonly batchSize?: number;
  /** Linhas do outbox já publicadas e mais antigas que isto são apagadas. */
  readonly outboxRetentionDays?: number;
}

/**
 * Rede de segurança para o que o outbox não enxerga. Para cada lead pendente há tempo demais
 * cujo último evento de outbox foi publicado, pergunta ao BullMQ pelo job:
 *  - `unknown`: o Redis perdeu o job (restart sem persistência, eviction, flush manual). Grava um
 *    novo evento de outbox e o fluxo normal assume.
 *  - `failed`: o job esgotou as tentativas, mas o handler não conseguiu marcar o lead (ex.: o
 *    Postgres estava fora no momento). Marca o lead como `failed` agora. Sem isso ele ficaria
 *    `pending` para sempre e, quando o BullMQ apagasse o job, seria reenfileirado por engano.
 *  - waiting, delayed, active: trabalho em andamento ou em backlog, não é tocado.
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

  async reconcileStuckLeads(): Promise<{ requeued: number; markedFailed: number }> {
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
    let markedFailed = 0;
    for (const { lead_id: leadId, outbox_id: outboxId } of candidates) {
      const state = await this.queue.getJobState(distributionJobId(leadId, outboxId.toString()));
      if (state === 'failed') {
        await markDistributionFailed(this.db, leadId);
        markedFailed++;
      } else if (state === 'unknown') {
        await this.db.outboxEvent.create({
          data: { type: DISTRIBUTION_REQUESTED, aggregateId: leadId, payload: { leadId } },
        });
        requeued++;
      }
    }
    if (requeued > 0 || markedFailed > 0) {
      this.logger.warn({ requeued, markedFailed }, 'reconciled stuck pending leads');
    }
    return { requeued, markedFailed };
  }

  /** Mantém o outbox pequeno: eventos publicados só são necessários numa janela curta de auditoria. */
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
