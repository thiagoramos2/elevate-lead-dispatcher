import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '../../infra/prisma.js';

/**
 * Liveness diz que o processo está de pé; readiness diz que ele pode receber tráfego. A
 * ingestão só precisa do Postgres, então o Redis fica de fora do readiness da API de propósito
 * (ADR-0002).
 */
export const healthRoutes: FastifyPluginAsyncZod<{ db: Database }> = async (app, { db }) => {
  app.get(
    '/health/live',
    { schema: { hide: true, response: { 200: z.object({ status: z.literal('ok') }) } } },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        hide: true,
        response: {
          200: z.object({ status: z.literal('ok') }),
          503: z.object({ status: z.literal('unavailable') }),
        },
      },
    },
    async (request, reply) => {
      try {
        await db.$queryRaw`SELECT 1`;
        return { status: 'ok' as const };
      } catch (error) {
        request.log.warn({ err: error }, 'readiness check failed');
        return reply.status(503).send({ status: 'unavailable' as const });
      }
    },
  );
};
