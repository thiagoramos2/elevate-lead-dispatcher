import {
  dispatcherConfigSchema,
  errorResponseSchema,
  updateDispatcherConfigSchema,
} from '@elevate/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '../../infra/prisma.js';
import { currentUser, requireUser } from '../auth/guards.js';
import {
  readDispatcherConfig,
  redistributeFailedLead,
  updateDispatcherConfig,
} from './admin.repository.js';

export interface AdminRoutesOptions {
  readonly db: Database;
  readonly ttlHours: number;
}

/** Rotas administrativas: só ADMIN. Um OPERATOR recebe 403 mesmo chamando a API direto. */
export const adminRoutes: FastifyPluginAsyncZod<AdminRoutesOptions> = async (
  app,
  { db, ttlHours },
) => {
  app.addHook('preHandler', requireUser(db, ttlHours, ['admin']));

  const errors = { 401: errorResponseSchema, 403: errorResponseSchema };

  app.get(
    '/api/admin/dispatcher',
    {
      schema: {
        tags: ['admin'],
        summary: 'Current dispatcher configuration and distribution totals',
        response: { 200: dispatcherConfigSchema, ...errors },
      },
    },
    async () => readDispatcherConfig(db),
  );

  app.put(
    '/api/admin/dispatcher',
    {
      schema: {
        tags: ['admin'],
        summary: 'Change call center weights / active flags (resets the dispatcher cursor)',
        body: updateDispatcherConfigSchema,
        response: { 200: dispatcherConfigSchema, 422: errorResponseSchema, ...errors },
      },
    },
    async (request) => {
      await updateDispatcherConfig(db, request.body);
      request.log.info(
        { adminId: currentUser(request).id, callCenters: request.body.callCenters },
        'dispatcher configuration changed',
      );
      return readDispatcherConfig(db);
    },
  );

  app.post(
    '/api/admin/leads/:id/redistribute',
    {
      schema: {
        tags: ['admin'],
        summary: 'Retry the distribution of a lead whose distribution failed',
        params: z.object({ id: z.uuid() }),
        response: {
          202: z.object({ success: z.literal(true), distribution_status: z.literal('pending') }),
          404: errorResponseSchema,
          409: errorResponseSchema,
          ...errors,
        },
      },
    },
    async (request, reply) => {
      await redistributeFailedLead(db, request.params.id);
      request.log.info(
        { adminId: currentUser(request).id, leadId: request.params.id },
        'lead redistribution requested',
      );
      return reply.status(202).send({ success: true, distribution_status: 'pending' });
    },
  );
};
