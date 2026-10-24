import type { DistributionStatus } from '@elevate/contracts';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../infra/prisma.js';

type Tx = Prisma.TransactionClient;

/**
 * Lock order is part of the contract: a lead row first, then dispatcher_state.
 * Every transaction that takes both must take them in this order, or it can deadlock.
 */

/** Locks the lead row for the rest of the transaction. */
export async function lockLead(
  tx: Tx,
  leadId: string,
): Promise<{ distributionStatus: DistributionStatus; callCenterId: string | null } | null> {
  const rows = await tx.$queryRaw<
    { distribution_status: DistributionStatus; call_center_id: string | null }[]
  >`
    SELECT distribution_status, call_center_id
    FROM leads WHERE id = ${leadId}::uuid
    FOR UPDATE`;
  const row = rows[0];
  return row
    ? { distributionStatus: row.distribution_status, callCenterId: row.call_center_id }
    : null;
}

export interface DispatcherConfig {
  readonly configVersion: number;
  /** Active call centers in a stable order (slug), so the schedule is reproducible. */
  readonly callCenters: { id: string; weight: number }[];
}

/**
 * Reads the dispatcher configuration without locking. It may be stale by the time we take
 * the cursor; advanceCursor detects that through config_version (optimistic check).
 */
export async function readDispatcherConfig(tx: Tx): Promise<DispatcherConfig> {
  const rows = await tx.$queryRaw<
    { config_version: number; id: string | null; weight: number | null }[]
  >`
    SELECT s.config_version, c.id, c.weight
    FROM dispatcher_state s
    LEFT JOIN call_centers c ON c.active
    WHERE s.id = 1
    ORDER BY c.slug`;
  const first = rows[0];
  if (!first) throw new Error('dispatcher_state row is missing; migrations not applied?');
  return {
    configVersion: first.config_version,
    callCenters: rows.flatMap((r) => (r.id && r.weight ? [{ id: r.id, weight: r.weight }] : [])),
  };
}

/**
 * Atomically takes the next cursor value, only if the configuration is still the one we read.
 *
 * The UPDATE holds the row lock until commit, so concurrent transactions queue here and each
 * one gets a distinct value. If an admin changed the configuration while we waited for the
 * lock, Postgres re-evaluates the WHERE on the new row version and nothing is updated: the
 * caller gets null and must re-read. On rollback the increment is undone, so the cursor is
 * gap-free (ADR-0003).
 */
export async function advanceCursor(tx: Tx, expectedConfigVersion: number): Promise<bigint | null> {
  const rows = await tx.$queryRaw<{ cursor: bigint }[]>`
    UPDATE dispatcher_state SET cursor = cursor + 1, updated_at = now()
    WHERE id = 1 AND config_version = ${expectedConfigVersion}
    RETURNING cursor`;
  return rows[0]?.cursor ?? null;
}

/** Writes the audit record and the lead's current assignment in a single statement. */
export async function recordDistribution(
  tx: Tx,
  input: { leadId: string; callCenterId: string; cursor: bigint; configVersion: number },
): Promise<void> {
  await tx.$executeRaw`
    WITH distribution AS (
      INSERT INTO distributions (lead_id, call_center_id, cursor, config_version)
      VALUES (${input.leadId}::uuid, ${input.callCenterId}::uuid, ${input.cursor}, ${input.configVersion})
      RETURNING lead_id, call_center_id, created_at
    )
    UPDATE leads
    SET distribution_status = 'distributed', call_center_id = distribution.call_center_id,
        distributed_at = distribution.created_at, updated_at = now()
    FROM distribution
    WHERE leads.id = distribution.lead_id`;
}

/** Marks a lead whose distribution exhausted its retries. No-op if it got distributed meanwhile. */
export async function markDistributionFailed(db: Database, leadId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE leads SET distribution_status = 'failed', updated_at = now()
    WHERE id = ${leadId}::uuid AND distribution_status = 'pending'`;
}
