import type {
  CatalogResponse,
  DistributionStatus,
  LeadDetail,
  LeadFilters,
  LeadListItem,
  LeadStatus,
  MetricsResponse,
} from '@elevate/contracts';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../infra/errors.js';
import type { Database } from '../../infra/prisma.js';

/** Cursor da paginação keyset: posição (created_at, id) do último item da página anterior. */
interface Cursor {
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt.toISOString(), i: cursor.id })).toString(
    'base64url',
  );
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'i' in parsed &&
      't' in parsed &&
      typeof parsed.i === 'string' &&
      typeof parsed.t === 'string' &&
      /^[0-9a-f-]{36}$/.test(parsed.i) &&
      !Number.isNaN(Date.parse(parsed.t))
    ) {
      return { createdAt: new Date(parsed.t), id: parsed.i };
    }
  } catch {
    // cai no erro abaixo
  }
  throw new AppError(400, 'INVALID_CURSOR', 'Invalid pagination cursor');
}

/**
 * Condições de filtro, sempre parametrizadas. `scope` é o call center do OPERATOR (vem da sessão):
 * é combinado com AND ao filtro do cliente, então pedir outro call center devolve vazio, nunca
 * dados alheios.
 */
function filterConditions(filters: LeadFilters, scope: string | null): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (scope) conditions.push(Prisma.sql`l.call_center_id = ${scope}::uuid`);
  if (filters.callCenter)
    conditions.push(Prisma.sql`l.call_center_id = ${filters.callCenter}::uuid`);
  if (filters.from) conditions.push(Prisma.sql`l.created_at >= ${new Date(filters.from)}`);
  if (filters.to) conditions.push(Prisma.sql`l.created_at < ${new Date(filters.to)}`);
  if (filters.product) conditions.push(Prisma.sql`l.product_id = ${filters.product}::uuid`);
  if (filters.funnel) conditions.push(Prisma.sql`l.funnel_id = ${filters.funnel}::uuid`);
  if (filters.source) conditions.push(Prisma.sql`l.source = ${filters.source}`);
  if (filters.status) conditions.push(Prisma.sql`l.status = ${filters.status}::lead_status`);
  if (filters.distribution) {
    conditions.push(
      Prisma.sql`l.distribution_status = ${filters.distribution}::distribution_status`,
    );
  }
  return conditions;
}

const where = (conditions: Prisma.Sql[]) =>
  conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

type LeadRow = {
  id: string;
  name: string;
  email: string;
  phone: string;
  source: string;
  campaign: string | null;
  status: LeadStatus;
  distribution_status: DistributionStatus;
  created_at: Date;
  distributed_at: Date | null;
  product_id: string;
  product_name: string;
  product_slug: string;
  funnel_id: string;
  funnel_name: string;
  funnel_slug: string;
  affiliate: string | null;
  call_center_id: string | null;
  call_center_name: string | null;
};

const LEAD_COLUMNS = Prisma.sql`
  l.id, l.name, l.email, l.phone, l.source, l.campaign, l.status, l.distribution_status,
  l.created_at, l.distributed_at,
  p.id AS product_id, p.name AS product_name, p.slug AS product_slug,
  f.id AS funnel_id, f.name AS funnel_name, f.slug AS funnel_slug,
  a.external_ref AS affiliate,
  c.id AS call_center_id, c.name AS call_center_name`;

const LEAD_JOINS = Prisma.sql`
  JOIN products p ON p.id = l.product_id
  JOIN funnels f ON f.id = l.funnel_id
  LEFT JOIN affiliates a ON a.id = l.affiliate_id
  LEFT JOIN call_centers c ON c.id = l.call_center_id`;

const toListItem = (row: LeadRow): LeadListItem => ({
  id: row.id,
  name: row.name,
  email: row.email,
  phone: row.phone,
  product: { id: row.product_id, name: row.product_name, slug: row.product_slug },
  funnel: { id: row.funnel_id, name: row.funnel_name, slug: row.funnel_slug },
  source: row.source,
  campaign: row.campaign,
  affiliate: row.affiliate,
  callCenter:
    row.call_center_id && row.call_center_name
      ? { id: row.call_center_id, name: row.call_center_name }
      : null,
  status: row.status,
  distributionStatus: row.distribution_status,
  createdAt: row.created_at.toISOString(),
  distributedAt: row.distributed_at?.toISOString() ?? null,
});

/**
 * Listagem paginada por keyset sobre (created_at, id): o custo da página 1 e da página 50.000 é o
 * mesmo, ao contrário de OFFSET. Usa os índices `leads_created_at_id_idx` e
 * `leads_call_center_created_at_idx` (OPERATOR).
 */
export async function listLeads(
  db: Database,
  filters: LeadFilters & { cursor?: string | undefined; limit: number },
  scope: string | null,
): Promise<{ items: LeadListItem[]; nextCursor: string | null }> {
  const conditions = filterConditions(filters, scope);
  if (filters.cursor) {
    const cursor = decodeCursor(filters.cursor);
    conditions.push(Prisma.sql`(l.created_at, l.id) < (${cursor.createdAt}, ${cursor.id}::uuid)`);
  }
  // Busca um item a mais para saber se existe próxima página sem fazer COUNT.
  const rows = await db.$queryRaw<LeadRow[]>`
    SELECT ${LEAD_COLUMNS}
    FROM leads l ${LEAD_JOINS}
    ${where(conditions)}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ${filters.limit + 1}`;

  const page = rows.slice(0, filters.limit);
  const last = page.at(-1);
  return {
    items: page.map(toListItem),
    nextCursor:
      rows.length > filters.limit && last
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
  };
}

/**
 * Todas as métricas numa única passada, respeitando os mesmos filtros e o escopo da listagem.
 * "Hoje" é calculado no fuso de reporte (padrão America/Sao_Paulo), não em UTC.
 */
export async function leadMetrics(
  db: Database,
  filters: LeadFilters,
  scope: string | null,
  timezone: string,
): Promise<MetricsResponse> {
  const rows = await db.$queryRaw<Omit<MetricsResponse, 'conversionRate'>[]>`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (
        WHERE l.created_at >= (date_trunc('day', now() AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone})
      )::int AS today,
      count(*) FILTER (WHERE l.distribution_status = 'distributed')::int AS distributed,
      count(*) FILTER (WHERE l.distribution_status = 'pending')::int AS pending,
      count(*) FILTER (WHERE l.distribution_status = 'distributed' AND l.status = 'new')::int AS "awaitingContact",
      count(*) FILTER (WHERE l.distribution_status = 'failed')::int AS failed,
      count(*) FILTER (WHERE l.status = 'sale')::int AS sales
    FROM leads l
    ${where(filterConditions(filters, scope))}`;
  const row = rows[0];
  if (!row) throw new Error('metrics query returned no row');
  return { ...row, conversionRate: row.total === 0 ? 0 : row.sales / row.total };
}

/** Detalhe do lead com o histórico completo de eventos. null se não existir ou estiver fora do escopo. */
export async function findLeadDetail(
  db: Database,
  leadId: string,
  scope: string | null,
): Promise<LeadDetail | null> {
  const conditions = [Prisma.sql`l.id = ${leadId}::uuid`, ...filterConditions({}, scope)];
  const rows = await db.$queryRaw<
    (LeadRow & {
      utm_source: string | null;
      utm_medium: string | null;
      utm_campaign: string | null;
      utm_content: string | null;
      utm_term: string | null;
    })[]
  >`
    SELECT ${LEAD_COLUMNS}, l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term
    FROM leads l ${LEAD_JOINS}
    ${where(conditions)}`;
  const row = rows[0];
  if (!row) return null;

  const events = await db.leadEvent.findMany({
    where: { leadId },
    orderBy: [{ occurredAt: 'asc' }, { receivedAt: 'asc' }],
    include: { actor: { select: { email: true } } },
  });

  return {
    ...toListItem(row),
    utm: {
      source: row.utm_source,
      medium: row.utm_medium,
      campaign: row.utm_campaign,
      content: row.utm_content,
      term: row.utm_term,
    },
    events: events.map((e) => ({
      id: e.id,
      origin: e.origin,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      occurredAt: e.occurredAt.toISOString(),
      receivedAt: e.receivedAt.toISOString(),
      applied: e.applied,
      rejectionReason: e.rejectionReason,
      externalId: e.externalId,
      actorEmail: e.actor?.email ?? null,
    })),
  };
}

/** Dados para os filtros do dashboard. O OPERATOR só recebe o próprio call center. */
export async function catalog(db: Database, scope: string | null): Promise<CatalogResponse> {
  const [products, callCenters] = await Promise.all([
    db.product.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        funnels: { orderBy: { slug: 'asc' }, select: { id: true, name: true, slug: true } },
      },
    }),
    db.callCenter.findMany({
      where: scope ? { id: scope } : {},
      orderBy: { slug: 'asc' },
      select: { id: true, name: true },
    }),
  ]);
  return { products, callCenters };
}
