import { buildWeightedSchedule, pickSlot } from '../../domain/weighted-schedule.js';
import type { Database } from '../../infra/prisma.js';
import {
  advanceCursor,
  lockLead,
  readDispatcherConfig,
  recordDistribution,
} from './distribution.repository.js';

/** The lead does not exist: retrying cannot help. */
export class LeadNotFoundError extends Error {
  override readonly name = 'LeadNotFoundError';
}

/** Nobody can take the lead right now. Transient: an admin may reactivate a call center. */
export class NoActiveCallCenterError extends Error {
  override readonly name = 'NoActiveCallCenterError';
}

export type DistributionOutcome =
  | { readonly kind: 'distributed'; readonly callCenterId: string; readonly cursor: bigint }
  | { readonly kind: 'already_distributed'; readonly callCenterId: string | null };

/** Configuration changes are rare admin actions; a few optimistic re-reads always suffice. */
const MAX_CONFIG_RACES = 3;

const TRANSACTION_OPTIONS = {
  // Waiting to *start* includes waiting for a pooled connection; under a burst, transactions
  // queue behind the dispatcher lock, so allow more than Prisma's 2s default.
  maxWait: 10_000,
  timeout: 10_000,
} as const;

/**
 * Assigns a lead to a call center (ADR-0003). Safe to call any number of times, from any
 * number of workers, concurrently:
 *  - the lead row lock serializes attempts on the same lead, and an already distributed
 *    lead is a no-op that does not consume a cursor value;
 *  - the dispatcher_state row lock serializes cursor allocation across all leads. The
 *    critical section is kept to two statements plus COMMIT: the configuration is read
 *    before the lock and validated optimistically by config_version;
 *  - UNIQUE(distributions.lead_id) rejects a duplicate even if the code above were wrong.
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

      // ---- critical section: dispatcher_state locked from here until COMMIT ----
      const cursor = await advanceCursor(tx, config.configVersion);
      if (cursor === null) continue; // configuration changed while we waited; re-read
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
