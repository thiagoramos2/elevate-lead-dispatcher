import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyError } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { AppConfig } from './config/env.js';
import { AppError, type FieldError } from './infra/errors.js';
import { loggerOptions } from './infra/logger.js';
import type { Database } from './infra/prisma.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { leadRoutes } from './modules/leads/lead.routes.js';
import { webhookRoutes } from './modules/webhooks/webhook.routes.js';

export interface AppDependencies {
  readonly config: AppConfig;
  readonly db: Database;
}

const BODY_LIMIT_BYTES = 64 * 1024;

function errorBody(code: string, message: string, details?: readonly FieldError[]) {
  return { success: false as const, error: { code, message, ...(details ? { details } : {}) } };
}

export type App = Awaited<ReturnType<typeof buildApp>>;

export async function buildApp({ config, db }: AppDependencies) {
  const app = Fastify({
    logger: loggerOptions(config.LOG_LEVEL, config.NODE_ENV === 'development'),
    bodyLimit: BODY_LIMIT_BYTES,
    // Só confia no X-Forwarded-For quando há um proxy conhecido na frente (o container web).
    trustProxy: (_address: string, hop: number) => hop < config.TRUST_PROXY_HOPS,
    requestIdHeader: 'x-request-id',
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .send(errorBody(error.code, error.message, error.details));
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      const details = error.validation.map((issue) => ({
        path: issue.instancePath.replace(/^\//, '').replaceAll('/', '.') || request.url,
        message: issue.message ?? 'Invalid value',
      }));
      return reply
        .status(400)
        .send(errorBody('VALIDATION_ERROR', 'Request validation failed', details));
    }
    // Erros de cliente do próprio Fastify (JSON malformado, content type errado, corpo grande demais...).
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      return reply
        .status(error.statusCode)
        .send(errorBody(error.code ?? 'BAD_REQUEST', error.message));
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send(errorBody('INTERNAL_ERROR', 'Internal server error'));
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(errorBody('NOT_FOUND', 'Route not found')),
  );

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Elevate Lead Dispatcher API',
        version: '1.0.0',
        description: 'Lead ingestion, distribution and call center webhooks.',
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  await app.register(healthRoutes, { db });
  await app.register(leadRoutes, { db });
  await app.register(webhookRoutes, { db, secrets: config.CALLCENTER_WEBHOOK_SECRETS });

  return app;
}
