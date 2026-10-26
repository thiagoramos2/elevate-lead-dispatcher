import { z } from 'zod';
import { distributionStatusSchema, leadStatusSchema } from './enums.js';

/** Filtros compartilhados pela listagem e pelas métricas. Datas em ISO 8601; `to` é exclusivo. */
export const leadFiltersSchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  product: z.uuid().optional(),
  funnel: z.uuid().optional(),
  source: z.string().trim().toLowerCase().max(64).optional(),
  callCenter: z.uuid().optional(),
  status: leadStatusSchema.optional(),
  distribution: distributionStatusSchema.optional(),
});
export type LeadFilters = z.infer<typeof leadFiltersSchema>;

export const listLeadsQuerySchema = leadFiltersSchema.extend({
  /** Cursor opaco devolvido pela página anterior (paginação keyset). */
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;

const ref = z.object({ id: z.uuid(), name: z.string() });

export const leadListItemSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  product: ref.extend({ slug: z.string() }),
  funnel: ref.extend({ slug: z.string() }),
  source: z.string(),
  campaign: z.string().nullable(),
  affiliate: z.string().nullable(),
  callCenter: ref.nullable(),
  status: leadStatusSchema,
  distributionStatus: distributionStatusSchema,
  createdAt: z.iso.datetime(),
  distributedAt: z.iso.datetime().nullable(),
});
export type LeadListItem = z.infer<typeof leadListItemSchema>;

export const listLeadsResponseSchema = z.object({
  items: z.array(leadListItemSchema),
  nextCursor: z.string().nullable(),
});
export type ListLeadsResponse = z.infer<typeof listLeadsResponseSchema>;

export const leadEventSchema = z.object({
  id: z.uuid(),
  origin: z.enum(['system', 'webhook', 'operator']),
  fromStatus: leadStatusSchema.nullable(),
  toStatus: leadStatusSchema,
  occurredAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  applied: z.boolean(),
  rejectionReason: z.string().nullable(),
  externalId: z.string().nullable(),
  actorEmail: z.string().nullable(),
});

export const leadDetailSchema = leadListItemSchema.extend({
  utm: z.object({
    source: z.string().nullable(),
    medium: z.string().nullable(),
    campaign: z.string().nullable(),
    content: z.string().nullable(),
    term: z.string().nullable(),
  }),
  events: z.array(leadEventSchema),
});
export type LeadDetail = z.infer<typeof leadDetailSchema>;

export const updateLeadStatusSchema = z.object({ status: leadStatusSchema });

export const metricsResponseSchema = z.object({
  total: z.number().int(),
  today: z.number().int(),
  distributed: z.number().int(),
  /** Aguardando distribuição (o worker ainda não atribuiu um call center). */
  pending: z.number().int(),
  /** Distribuídos que ainda não tiveram nenhum contato (status `new`). */
  awaitingContact: z.number().int(),
  failed: z.number().int(),
  sales: z.number().int(),
  /** Vendas / total, entre 0 e 1. */
  conversionRate: z.number(),
});
export type MetricsResponse = z.infer<typeof metricsResponseSchema>;

export const catalogResponseSchema = z.object({
  products: z.array(
    ref.extend({ slug: z.string(), funnels: z.array(ref.extend({ slug: z.string() })) }),
  ),
  callCenters: z.array(ref),
});
export type CatalogResponse = z.infer<typeof catalogResponseSchema>;

export const dispatcherConfigSchema = z.object({
  configVersion: z.number().int(),
  callCenters: z.array(
    ref.extend({
      slug: z.string(),
      weight: z.number().int(),
      active: z.boolean(),
      /** Participação configurada entre os ativos (0..1). */
      share: z.number(),
      distributedTotal: z.number().int(),
    }),
  ),
});
export type DispatcherConfig = z.infer<typeof dispatcherConfigSchema>;

export const updateDispatcherConfigSchema = z.object({
  callCenters: z
    .array(
      z.object({
        id: z.uuid(),
        weight: z.number().int().min(1).max(1000),
        active: z.boolean(),
      }),
    )
    .min(1),
});
export type UpdateDispatcherConfig = z.infer<typeof updateDispatcherConfigSchema>;
