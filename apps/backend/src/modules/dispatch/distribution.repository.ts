import type { DistributionStatus } from '@elevate/contracts';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../infra/prisma.js';

type Tx = Prisma.TransactionClient;

/**
 * A ordem dos locks faz parte do contrato: primeiro a linha do lead, depois o dispatcher_state.
 * Toda transação que pega os dois precisa pegá-los nesta ordem, senão pode haver deadlock.
 */

/** Trava a linha do lead até o fim da transação. */
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
  /** Call centers ativos numa ordem estável (slug), para o escalonamento ser reproduzível. */
  readonly callCenters: { id: string; weight: number }[];
}

/**
 * Lê a configuração do dispatcher sem lock. Ela pode estar desatualizada quando pegarmos o
 * cursor; advanceCursor detecta isso pelo config_version (checagem otimista).
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
 * Pega atomicamente o próximo valor do cursor, só se a configuração ainda for a que lemos.
 *
 * O UPDATE segura o row lock até o commit, então as transações concorrentes fazem fila aqui e
 * cada uma recebe um valor diferente. Se um admin mudou a configuração enquanto esperávamos o
 * lock, o Postgres reavalia o WHERE sobre a nova versão da linha e nada é atualizado: quem
 * chama recebe null e precisa reler. Em rollback o incremento é desfeito, então o cursor não
 * tem buracos (ADR-0003).
 */
export async function advanceCursor(tx: Tx, expectedConfigVersion: number): Promise<bigint | null> {
  const rows = await tx.$queryRaw<{ cursor: bigint }[]>`
    UPDATE dispatcher_state SET cursor = cursor + 1, updated_at = now()
    WHERE id = 1 AND config_version = ${expectedConfigVersion}
    RETURNING cursor`;
  return rows[0]?.cursor ?? null;
}

/** Grava o registro de auditoria e a atribuição atual do lead num único statement. */
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

/** Marca um lead cuja distribuição esgotou as tentativas. No-op se ele foi distribuído nesse meio-tempo. */
export async function markDistributionFailed(db: Database, leadId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE leads SET distribution_status = 'failed', updated_at = now()
    WHERE id = ${leadId}::uuid AND distribution_status = 'pending'`;
}
