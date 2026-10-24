import type { CreateLeadPayload, DistributionStatus } from '@elevate/contracts';
import { deriveIdempotency, sha256Hex } from '../../domain/idempotency.js';
import { conflict, unprocessable } from '../../infra/errors.js';
import type { Database } from '../../infra/prisma.js';
import {
  ensureAffiliate,
  findByIdempotencyKey,
  findCatalog,
  insertLeadIfAbsent,
  recordLeadCreated,
} from './lead.repository.js';

export interface CreateLeadResult {
  readonly leadId: string;
  readonly duplicate: boolean;
  readonly distributionStatus: DistributionStatus;
}

const SOURCE_MAX_LENGTH = 64;
const DEFAULT_SOURCE = 'direct';

/** `source` explícito, senão o source da UTM, senão "direct". Sempre gravado, para ser filtrável. */
function resolveSource(payload: CreateLeadPayload): string {
  const fromUtm = payload.utm?.source?.toLowerCase().slice(0, SOURCE_MAX_LENGTH);
  return payload.source ?? fromUtm ?? DEFAULT_SOURCE;
}

/**
 * Persiste o lead e o pedido de distribuição de forma atômica (ADR-0002, ADR-0004).
 * O lead é commitado antes de quem chama responder; a distribuição acontece no worker.
 */
export async function createLead(
  db: Database,
  payload: CreateLeadPayload,
  clientIdempotencyKey: string | undefined,
  receivedAt: Date = new Date(),
): Promise<CreateLeadResult> {
  const catalog = await findCatalog(db, payload.product, payload.funnel);
  if (!catalog) {
    throw unprocessable('UNKNOWN_PRODUCT', 'Product does not exist or is inactive', [
      { path: 'product', message: `unknown product "${payload.product}"` },
    ]);
  }
  if (!catalog.funnelId) {
    throw unprocessable('INVALID_FUNNEL', 'Funnel does not exist for this product', [
      { path: 'funnel', message: `funnel "${payload.funnel}" not found for "${payload.product}"` },
    ]);
  }
  const funnelId = catalog.funnelId;
  const identity = deriveIdempotency(payload, clientIdempotencyKey, receivedAt);

  return db.$transaction(async (tx) => {
    const affiliateId = payload.affiliate_id
      ? await ensureAffiliate(tx, payload.affiliate_id)
      : null;

    const inserted = await insertLeadIfAbsent(tx, {
      name: payload.name,
      email: payload.email,
      phone: payload.phone,
      productId: catalog.productId,
      funnelId,
      affiliateId,
      source: resolveSource(payload),
      campaign: payload.campaign ?? null,
      utmSource: payload.utm?.source ?? null,
      utmMedium: payload.utm?.medium ?? null,
      utmCampaign: payload.utm?.campaign ?? null,
      utmContent: payload.utm?.content ?? null,
      utmTerm: payload.utm?.term ?? null,
      idempotencyKey: identity.key,
      requestHash: identity.requestHash,
    });

    if (inserted) {
      await recordLeadCreated(tx, inserted, sha256Hex(`system:created:${inserted.id}`));
      return { leadId: inserted.id, duplicate: false, distributionStatus: 'pending' as const };
    }

    // Replay. Se uma requisição concorrente inseriu a mesma chave, o ON CONFLICT esperou o
    // commit dela, então a linha está visível aqui.
    const existing = await findByIdempotencyKey(tx, identity.key);
    if (!existing) throw new Error('idempotency conflict without an existing lead');
    if (existing.requestHash !== identity.requestHash) {
      throw conflict(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key was already used with a different payload',
      );
    }
    return {
      leadId: existing.id,
      duplicate: true,
      distributionStatus: existing.distributionStatus,
    };
  });
}
