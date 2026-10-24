import { buildWeightedSchedule, pickSlot } from '../../domain/weighted-schedule.js';
import type { Database } from '../../infra/prisma.js';
import {
  advanceCursor,
  lockLead,
  readDispatcherConfig,
  recordDistribution,
} from './distribution.repository.js';

/** O lead não existe: retentar não adianta. */
export class LeadNotFoundError extends Error {
  override readonly name = 'LeadNotFoundError';
}

/** Ninguém pode receber o lead agora. Transitório: um admin pode reativar um call center. */
export class NoActiveCallCenterError extends Error {
  override readonly name = 'NoActiveCallCenterError';
}

export type DistributionOutcome =
  | { readonly kind: 'distributed'; readonly callCenterId: string; readonly cursor: bigint }
  | { readonly kind: 'already_distributed'; readonly callCenterId: string | null };

/** Mudanças de configuração são ações raras de admin; poucas releituras otimistas sempre bastam. */
const MAX_CONFIG_RACES = 3;

const TRANSACTION_OPTIONS = {
  // Esperar para *iniciar* inclui esperar uma conexão do pool; numa rajada, as transações fazem
  // fila atrás do lock do dispatcher, então permitimos mais que os 2s padrão do Prisma.
  maxWait: 10_000,
  timeout: 10_000,
} as const;

/**
 * Atribui um lead a um call center (ADR-0003). Pode ser chamado quantas vezes for, por quantos
 * workers for, ao mesmo tempo:
 *  - o row lock do lead serializa as tentativas sobre o mesmo lead, e um lead já distribuído
 *    vira no-op que não consome valor do cursor;
 *  - o row lock do dispatcher_state serializa a alocação do cursor entre todos os leads. A
 *    seção crítica fica em dois statements mais o COMMIT: a configuração é lida antes do lock
 *    e validada de forma otimista pelo config_version;
 *  - UNIQUE(distributions.lead_id) rejeita uma duplicata mesmo que o código acima estivesse errado.
 */
export async function distributeLead(db: Database, leadId: string): Promise<DistributionOutcome> {
  return db.$transaction(async (tx) => {
    const lead = await lockLead(tx, leadId);
    if (!lead) throw new LeadNotFoundError(`lead ${leadId} not found`);
    if (lead.distributionStatus === 'distributed') {
      return { kind: 'already_distributed', callCenterId: lead.callCenterId };
    }

    for (let race = 0; race < MAX_CONFIG_RACES; race++) {
      const config = await readDispatcherConfig(tx);
      if (config.callCenters.length === 0) {
        throw new NoActiveCallCenterError('no active call center to receive the lead');
      }
      const schedule = buildWeightedSchedule(config.callCenters);

      // ---- seção crítica: dispatcher_state travado daqui até o COMMIT ----
      const cursor = await advanceCursor(tx, config.configVersion);
      if (cursor === null) continue; // a configuração mudou enquanto esperávamos; relê
      const callCenterId = pickSlot(schedule, cursor);
      await recordDistribution(tx, {
        leadId,
        callCenterId,
        cursor,
        configVersion: config.configVersion,
      });
      return { kind: 'distributed', callCenterId, cursor };
    }
    throw new Error(`dispatcher configuration changed ${MAX_CONFIG_RACES} times in a row`);
  }, TRANSACTION_OPTIONS);
}
