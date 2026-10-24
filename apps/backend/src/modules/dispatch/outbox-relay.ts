import type { Logger } from 'pino';
import type { Database } from '../../infra/prisma.js';

export interface PendingOutboxEvent {
  readonly id: bigint;
  readonly type: string;
  readonly aggregateId: string;
}

/** Publica um lote no transporte. Precisa lançar erro se algum evento não foi aceito. */
export type OutboxPublisher = (events: readonly PendingOutboxEvent[]) => Promise<void>;

export interface OutboxRelayOptions {
  readonly batchSize?: number;
  /** Teto do backoff exponencial aplicado aos eventos cuja publicação falhou. */
  readonly maxBackoffSeconds?: number;
}

/**
 * Move os eventos do outbox do Postgres para a fila (ADR-0002).
 *
 * - `FOR UPDATE SKIP LOCKED`: vários relays podem rodar ao mesmo tempo; cada um pega um lote diferente.
 * - O lote fica travado durante a publicação e só é marcado como publicado se o publisher teve
 *   sucesso. Uma queda no meio deixa o lote não publicado, e ele é publicado de novo depois:
 *   a entrega é at-least-once, e os consumidores são idempotentes.
 * - Em caso de falha (ex.: Redis fora do ar), os eventos recebem um backoff exponencial em
 *   `available_at`, para não martelar um transporte morto e sem perder nada.
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly maxBackoffSeconds: number;

  constructor(
    private readonly db: Database,
    private readonly publish: OutboxPublisher,
    private readonly logger: Logger,
    options: OutboxRelayOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.maxBackoffSeconds = options.maxBackoffSeconds ?? 60;
  }

  /** Publica um lote. Retorna quantos eventos foram publicados (0 se não havia nenhum ou se falhou). */
  async publishBatch(): Promise<number> {
    return this.db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: bigint; type: string; aggregate_id: string }[]>`
          SELECT id, type, aggregate_id
          FROM outbox_events
          WHERE published_at IS NULL AND available_at <= now()
          ORDER BY id
          LIMIT ${this.batchSize}
          FOR UPDATE SKIP LOCKED`;
        if (rows.length === 0) return 0;

        const events = rows.map((r) => ({ id: r.id, type: r.type, aggregateId: r.aggregate_id }));
        const ids = events.map((e) => e.id);

        try {
          await this.publish(events);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await tx.$executeRaw`
            UPDATE outbox_events
            SET attempts = attempts + 1,
                last_error = ${message.slice(0, 1000)},
                available_at = now() + make_interval(secs => least(power(2, attempts), ${this.maxBackoffSeconds}))
            WHERE id = ANY(${ids}::bigint[])`;
          this.logger.warn(
            { err: error, events: ids.length },
            'outbox publish failed; backing off',
          );
          return 0;
        }

        await tx.$executeRaw`
          UPDATE outbox_events SET published_at = now(), last_error = NULL
          WHERE id = ANY(${ids}::bigint[])`;
        return events.length;
      },
      { maxWait: 5_000, timeout: 15_000 },
    );
  }

  /** Esvazia tudo o que está disponível agora. Útil principalmente em testes e na inicialização. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const published = await this.publishBatch();
      total += published;
      if (published < this.batchSize) return total;
    }
  }
}
