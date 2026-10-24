import type { DistributionStatus } from '@elevate/contracts';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../infra/prisma.js';

type Tx = Prisma.TransactionClient;

export const DISTRIBUTION_REQUESTED = 'lead.distribution_requested';

export interface CatalogMatch {
  readonly productId: string;
  /** null when the product exists but has no active funnel with that slug. */
  readonly funnelId: string | null;
}

/** Resolves an active product and, within it, an active funnel. One round trip. */
export async function findCatalog(
  db: Database,
  productSlug: string,
  funnelSlug: string,
): Promise<CatalogMatch | null> {
  const rows = await db.$queryRaw<{ product_id: string; funnel_id: string | null }[]>`
    SELECT p.id AS product_id, f.id AS funnel_id
    FROM products p
    LEFT JOIN funnels f ON f.product_id = p.id AND f.slug = ${funnelSlug} AND f.active
    WHERE p.slug = ${productSlug} AND p.active`;
  const row = rows[0];
  return row ? { productId: row.product_id, funnelId: row.funnel_id } : null;
}

/**
 * Returns the affiliate id, creating it on first sight. Concurrent first sightings are safe:
 * the loser of the unique-index race waits for the winner's commit, inserts nothing, and the
 * follow-up SELECT (a new snapshot under READ COMMITTED) sees the committed row.
 */
export async function ensureAffiliate(tx: Tx, externalRef: string): Promise<string> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO affiliates (external_ref) VALUES (${externalRef})
    ON CONFLICT (external_ref) DO NOTHING
    RETURNING id`;
  if (inserted[0]) return inserted[0].id;

  const existing = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM affiliates WHERE external_ref = ${externalRef}`;
  if (!existing[0]) throw new Error(`affiliate ${externalRef} vanished after conflict`);
  return existing[0].id;
}

export interface NewLead {
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly productId: string;
  readonly funnelId: string;
  readonly affiliateId: string | null;
  readonly source: string;
  readonly campaign: string | null;
  readonly utmSource: string | null;
  readonly utmMedium: string | null;
  readonly utmCampaign: string | null;
  readonly utmContent: string | null;
  readonly utmTerm: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

/**
 * Inserts the lead unless its idempotency key already exists. Returns the new row, or null
 * on conflict. Never raises a unique violation, so the surrounding transaction stays usable.
 */
export async function insertLeadIfAbsent(
  tx: Tx,
  lead: NewLead,
): Promise<{ id: string; createdAt: Date } | null> {
  const rows = await tx.$queryRaw<{ id: string; created_at: Date }[]>`
    INSERT INTO leads (
      name, email, phone, product_id, funnel_id, affiliate_id,
      source, campaign, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
      idempotency_key, request_hash, updated_at
    ) VALUES (
      ${lead.name}, ${lead.email}, ${lead.phone},
      ${lead.productId}::uuid, ${lead.funnelId}::uuid, ${lead.affiliateId}::uuid,
      ${lead.source}, ${lead.campaign}, ${lead.utmSource}, ${lead.utmMedium},
      ${lead.utmCampaign}, ${lead.utmContent}, ${lead.utmTerm},
      ${lead.idempotencyKey}, ${lead.requestHash}, now()
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id, created_at`;
  const row = rows[0];
  return row ? { id: row.id, createdAt: row.created_at } : null;
}

export async function findByIdempotencyKey(
  tx: Tx,
  idempotencyKey: string,
): Promise<{ id: string; requestHash: string; distributionStatus: DistributionStatus } | null> {
  const rows = await tx.$queryRaw<
    { id: string; request_hash: string; distribution_status: DistributionStatus }[]
  >`
    SELECT id, request_hash, distribution_status
    FROM leads WHERE idempotency_key = ${idempotencyKey}`;
  const row = rows[0];
  return row
    ? { id: row.id, requestHash: row.request_hash, distributionStatus: row.distribution_status }
    : null;
}

/** Initial history entry (status `new`) and the outbox event that will trigger distribution. */
export async function recordLeadCreated(
  tx: Tx,
  lead: { id: string; createdAt: Date },
  dedupKey: string,
): Promise<void> {
  await tx.leadEvent.create({
    data: {
      leadId: lead.id,
      origin: 'system',
      dedupKey,
      toStatus: 'new',
      occurredAt: lead.createdAt,
      applied: true,
    },
  });
  await tx.outboxEvent.create({
    data: {
      type: DISTRIBUTION_REQUESTED,
      aggregateId: lead.id,
      payload: { leadId: lead.id },
    },
  });
}
