import type { LeadStatus } from '@elevate/contracts';
import { decideStatusChange, type StatusChangeRejection } from '../../domain/lead-status.js';
import { notFound } from '../../infra/errors.js';
import type { Database } from '../../infra/prisma.js';
import { insertLeadEventIfAbsent, lockLeadStatus, updateLeadStatus } from './status.repository.js';

export interface StatusEventInput {
  readonly leadId: string;
  readonly toStatus: LeadStatus;
  /** Quando aconteceu na origem (timestamp do call center ou o instante da ação do operador). */
  readonly occurredAt: Date;
  readonly origin: 'webhook' | 'operator';
  readonly dedupKey: string;
  /**
   * Call center ao qual quem chama está restrito. `null` só para ADMIN. Lead de outro call center
   * responde 404, igual a um lead inexistente, para não revelar que ele existe.
   */
  readonly scopeCallCenterId: string | null;
  readonly callCenterId: string | null;
  readonly actorUserId: string | null;
  readonly externalId: string | null;
  readonly payload: unknown;
}

export interface StatusEventResult {
  readonly duplicate: boolean;
  readonly applied: boolean;
  readonly reason?: StatusChangeRejection;
  /** Status do lead depois do evento. */
  readonly status: LeadStatus;
}

/**
 * Registra um evento de status e o aplica se ele for mais novo que o status atual e a transição
 * for permitida (ADR-0005). Todo evento novo é gravado, aplicado ou não, para auditoria.
 *
 * Concorrência: o lead fica travado durante a decisão, então dois eventos do mesmo lead nunca
 * decidem sobre o mesmo estado. Duplicatas são barradas por UNIQUE(lead_id, dedup_key).
 */
export async function recordStatusEvent(
  db: Database,
  input: StatusEventInput,
): Promise<StatusEventResult> {
  return db.$transaction(async (tx) => {
    const lead = await lockLeadStatus(tx, input.leadId);
    if (!lead) throw notFound('Lead not found');
    if (input.scopeCallCenterId !== null && lead.callCenterId !== input.scopeCallCenterId) {
      throw notFound('Lead not found');
    }

    const decision = decideStatusChange({
      current: lead.status,
      currentChangedAt: lead.statusChangedAt,
      next: input.toStatus,
      occurredAt: input.occurredAt,
    });

    const inserted = await insertLeadEventIfAbsent(tx, {
      leadId: input.leadId,
      origin: input.origin,
      callCenterId: input.callCenterId,
      actorUserId: input.actorUserId,
      dedupKey: input.dedupKey,
      externalId: input.externalId,
      fromStatus: lead.status,
      toStatus: input.toStatus,
      occurredAt: input.occurredAt,
      applied: decision.apply,
      rejectionReason: decision.apply ? null : decision.reason,
      payload: input.payload,
    });
    if (!inserted) return { duplicate: true, applied: false, status: lead.status };

    if (!decision.apply) {
      return { duplicate: false, applied: false, reason: decision.reason, status: lead.status };
    }
    await updateLeadStatus(tx, input.leadId, input.toStatus, input.occurredAt);
    return { duplicate: false, applied: true, status: input.toStatus };
  });
}
