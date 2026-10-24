import {
  createLeadResponseSchema,
  createLeadSchema,
  errorResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeySchema,
} from '@elevate/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '../../infra/prisma.js';
import { createLead } from './lead.service.js';

export const leadRoutes: FastifyPluginAsyncZod<{ db: Database }> = async (app, { db }) => {
  app.post(
    '/api/leads',
    {
      schema: {
        tags: ['leads'],
        summary: 'Receive a lead from a sales page',
        description:
          'Validates and stores the lead, then queues it for distribution. Retries are idempotent: ' +
          'send an Idempotency-Key header, or identical payloads are deduplicated by content hash.',
        // Loose: other headers must pass through untouched.
        headers: z.looseObject({ [IDEMPOTENCY_KEY_HEADER]: idempotencyKeySchema.optional() }),
        body: createLeadSchema,
        response: {
          201: createLeadResponseSchema.describe('Lead created'),
          200: createLeadResponseSchema.describe('Duplicate request: the original lead'),
          400: errorResponseSchema,
          409: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await createLead(db, request.body, request.headers[IDEMPOTENCY_KEY_HEADER]);
      return reply.status(result.duplicate ? 200 : 201).send({
        success: true,
        lead_id: result.leadId,
        duplicate: result.duplicate,
        distribution_status: result.distributionStatus,
      });
    },
  );
};
