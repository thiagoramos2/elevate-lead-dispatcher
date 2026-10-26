import type { LeadStatus } from '@elevate/contracts';
import type { Prisma } from '../../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

export interface LockedLeadStatus {
  readonly status: LeadStatus;
  readonly statusChangedAt: Date;
  readonly callCenterId: string | null;
}

/** Trava o lead: eventos concorrentes do mesmo lead são aplicados um de cada vez. */
export async function lockLeadStatus(tx: Tx, leadId: string): Promise<LockedLeadStatus | null> {
  const rows = await tx.$queryRaw<
    { status: LeadStatus; status_changed_at: Date; call_center_id: string | null }[]
  >`
    SELECT status, status_changed_at, call_center_id
    FROM leads WHERE id = ${leadId}::uuid
    FOR UPDATE`;
  const row = rows[0];
  return row
    ? {
        status: row.status,
        statusChangedAt: row.status_changed_at,
        callCenterId: row.call_center_id,
      }
    : null;
}

export interface NewLeadEvent {
  readonly leadId: string;
  readonly origin: 'webhook' | 'operator';
  readonly callCenterId: string | null;
  readonly actorUserId: string | null;
  readonly dedupKey: string;
  readonly externalId: string | null;
  readonly fromStatus: LeadStatus;
  readonly toStatus: LeadStatus;
  readonly occurredAt: Date;
  readonly applied: boolean;
  readonly rejectionReason: string | null;
  readonly payload: unknown;
}

/**
 * Grava o evento no histórico, a menos que ele já exista (mesma dedup_key para o lead).
 * Retorna false para duplicata. Nunca gera violação de unicidade, então a transação continua utilizável.
 */
export async function insertLeadEventIfAbsent(tx: Tx, event: NewLeadEvent): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO lead_events (
      lead_id, origin, call_center_id, actor_user_id, dedup_key, external_id,
      from_status, to_status, occurred_at, applied, rejection_reason, payload
    ) VALUES (
      ${event.leadId}::uuid, ${event.origin}::lead_event_origin,
      ${event.callCenterId}::uuid, ${event.actorUserId}::uuid,
      ${event.dedupKey}, ${event.externalId},
      ${event.fromStatus}::lead_status, ${event.toStatus}::lead_status,
      ${event.occurredAt}, ${event.applied}, ${event.rejectionReason},
      ${event.payload === null ? null : JSON.stringify(event.payload)}::jsonb
    )
    ON CONFLICT (lead_id, dedup_key) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

export async function updateLeadStatus(
  tx: Tx,
  leadId: string,
  status: LeadStatus,
  changedAt: Date,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE leads
    SET status = ${status}::lead_status, status_changed_at = ${changedAt}, updated_at = now()
    WHERE id = ${leadId}::uuid`;
}
