import type { DispatcherConfig, UpdateDispatcherConfig } from '@elevate/contracts';
import { AppError, notFound, unprocessable } from '../../infra/errors.js';
import type { Database } from '../../infra/prisma.js';
import { DISTRIBUTION_REQUESTED } from '../leads/lead.repository.js';

/**
 * Configuração atual do dispatcher. O total distribuído por call center sai de `leads`, que tem
 * índice por `call_center_id` (`distributions` não tem, de propósito).
 */
export async function readDispatcherConfig(db: Database): Promise<DispatcherConfig> {
  const rows = await db.$queryRaw<
    {
      id: string;
      slug: string;
      name: string;
      weight: number;
      active: boolean;
      config_version: number;
      distributed_total: number;
    }[]
  >`
    SELECT c.id, c.slug, c.name, c.weight, c.active, s.config_version,
           (SELECT count(*) FROM leads l WHERE l.call_center_id = c.id)::int AS distributed_total
    FROM call_centers c CROSS JOIN dispatcher_state s
    WHERE s.id = 1
    ORDER BY c.slug`;
  const activeWeight = rows.filter((r) => r.active).reduce((sum, r) => sum + r.weight, 0);
  return {
    configVersion: rows[0]?.config_version ?? 1,
    callCenters: rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      weight: r.weight,
      active: r.active,
      share: r.active && activeWeight > 0 ? r.weight / activeWeight : 0,
      distributedTotal: r.distributed_total,
    })),
  };
}

/**
 * Altera pesos e ativos (ADR-0003): trava o dispatcher_state, aplica as mudanças, incrementa
 * config_version e zera o cursor, tudo numa transação. Workers que leram a configuração antiga
 * falham na checagem otimista e releem. Esta transação só trava dispatcher_state (nunca leads),
 * então não há como formar deadlock com a distribuição.
 */
export async function updateDispatcherConfig(
  db: Database,
  input: UpdateDispatcherConfig,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM dispatcher_state WHERE id = 1 FOR UPDATE`;

    for (const center of input.callCenters) {
      const updated = await tx.callCenter.updateMany({
        where: { id: center.id },
        data: { weight: center.weight, active: center.active },
      });
      if (updated.count === 0) {
        throw unprocessable('UNKNOWN_CALL_CENTER', 'Call center does not exist', [
          { path: 'callCenters', message: `unknown call center ${center.id}` },
        ]);
      }
    }

    if ((await tx.callCenter.count({ where: { active: true } })) === 0) {
      throw unprocessable('NO_ACTIVE_CALL_CENTER', 'At least one call center must stay active');
    }

    await tx.$executeRaw`
      UPDATE dispatcher_state
      SET config_version = config_version + 1, cursor = 0, updated_at = now()
      WHERE id = 1`;
  });
}

/**
 * Reprocessa um lead cuja distribuição falhou de forma definitiva: volta para `pending` e grava
 * um novo evento de outbox; daí em diante o fluxo normal assume (relay → fila → worker).
 */
export async function redistributeFailedLead(db: Database, leadId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE leads SET distribution_status = 'pending', updated_at = now()
      WHERE id = ${leadId}::uuid AND distribution_status = 'failed'`;
    if (updated === 0) {
      const exists = await tx.lead.findUnique({ where: { id: leadId }, select: { id: true } });
      if (!exists) throw notFound('Lead not found');
      throw new AppError(
        409,
        'LEAD_NOT_FAILED',
        'Only leads whose distribution failed can be redistributed',
      );
    }
    await tx.outboxEvent.create({
      data: { type: DISTRIBUTION_REQUESTED, aggregateId: leadId, payload: { leadId } },
    });
  });
}
