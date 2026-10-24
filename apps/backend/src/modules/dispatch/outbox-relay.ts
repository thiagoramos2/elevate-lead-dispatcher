import type { Logger } from 'pino';
import type { Database } from '../../infra/prisma.js';

export interface PendingOutboxEvent {
  readonly id: bigint;
  readonly type: string;
  readonly aggregateId: string;
}

/** Publishes a batch to the transport. Must throw if any event was not accepted. */
export type OutboxPublisher = (events: readonly PendingOutboxEvent[]) => Promise<void>;

export interface OutboxRelayOptions {
  readonly batchSize?: number;
  /** Upper bound of the exponential backoff applied to events whose publication failed. */
  readonly maxBackoffSeconds?: number;
}

/**
 * Moves outbox events from Postgres to the queue (ADR-0002).
 *
 * - `FOR UPDATE SKIP LOCKED`: several relays can run at once; each claims a disjoint batch.
 * - The batch stays locked while publishing, and is marked published only if the publisher
 *   succeeded. A crash in between leaves it unpublished, so it is published again later:
 *   delivery is at-least-once, and consumers are idempotent.
 * - On failure (e.g. Redis down) the events get an exponential `available_at` backoff,
 *   so a dead transport is not hammered and nothing is lost.
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

  /** Publishes one batch. Returns how many events were published (0 if none or on failure). */
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

  /** Drains everything currently available. Mostly useful in tests and at startup. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const published = await this.publishBatch();
      total += published;
      if (published < this.batchSize) return total;
    }
  }
}
