import { randomUUID } from 'node:crypto';
import {
  catalogResponseSchema,
  errorResponseSchema,
  leadDetailSchema,
  leadFiltersSchema,
  listLeadsQuerySchema,
  listLeadsResponseSchema,
  metricsResponseSchema,
  updateLeadStatusSchema,
} from '@elevate/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sha256Hex } from '../../domain/idempotency.js';
import { AppError, notFound } from '../../infra/errors.js';
import type { Database } from '../../infra/prisma.js';
import { callCenterScope, currentUser, requireUser } from '../auth/guards.js';
import { recordStatusEvent } from '../status/status.service.js';
import { catalog, findLeadDetail, leadMetrics, listLeads } from './dashboard.repository.js';

export interface DashboardRoutesOptions {
  readonly db: Database;
  readonly ttlHours: number;
  readonly timezone: string;
}

const leadParams = z.object({ id: z.uuid() });

/** Rotas do dashboard. ADMIN e OPERATOR; o escopo do OPERATOR é aplicado em todas as consultas. */
export const dashboardRoutes: FastifyPluginAsyncZod<DashboardRoutesOptions> = async (
  app,
  { db, ttlHours, timezone },
) => {
  app.addHook('preHandler', requireUser(db, ttlHours));

  app.get(
    '/api/leads',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'List leads (keyset pagination, filters)',
        querystring: listLeadsQuerySchema,
        response: {
          200: listLeadsResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request) => listLeads(db, request.query, callCenterScope(currentUser(request))),
  );

  app.get(
    '/api/leads/metrics',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Dashboard metrics for the same filters as the list',
        querystring: leadFiltersSchema,
        response: { 200: metricsResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) =>
      leadMetrics(db, request.query, callCenterScope(currentUser(request)), timezone),
  );

  app.get(
    '/api/leads/:id',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Lead detail with full status history',
        params: leadParams,
        response: { 200: leadDetailSchema, 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => {
      const lead = await findLeadDetail(
        db,
        request.params.id,
        callCenterScope(currentUser(request)),
      );
      if (!lead) throw notFound('Lead not found');
      return lead;
    },
  );

  app.patch(
    '/api/leads/:id/status',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Update a lead status (operator of its call center, or admin)',
        params: leadParams,
        body: updateLeadStatusSchema,
        response: {
          200: z.object({ success: z.literal(true), status: updateLeadStatusSchema.shape.status }),
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const user = currentUser(request);
      const result = await recordStatusEvent(db, {
        leadId: request.params.id,
        toStatus: request.body.status,
        occurredAt: new Date(),
        origin: 'operator',
        // Cada ação humana é um evento distinto; a mesma regra de ordenação do webhook vale aqui.
        dedupKey: sha256Hex(`operator|${user.id}|${randomUUID()}`),
        scopeCallCenterId: callCenterScope(user),
        callCenterId: user.callCenterId,
        actorUserId: user.id,
        externalId: null,
        payload: request.body,
      });
      // Para um humano, uma transição recusada é erro (diferente do webhook, que responde 200 para o
      // parceiro não reenviar). O evento recusado continua gravado no histórico.
      if (!result.applied && result.reason === 'invalid_transition') {
        throw new AppError(
          422,
          'INVALID_TRANSITION',
          `Cannot change status from "${result.status}" to "${request.body.status}"`,
        );
      }
      if (!result.applied) {
        throw new AppError(409, 'STALE_UPDATE', 'The lead was updated by a newer event');
      }
      return { success: true as const, status: result.status };
    },
  );

  app.get(
    '/api/catalog',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Products, funnels and call centers for the dashboard filters',
        response: { 200: catalogResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) => catalog(db, callCenterScope(currentUser(request))),
  );
};
