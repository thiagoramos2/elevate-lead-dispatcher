import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
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
import type { Redis } from 'ioredis';
import { type AppConfig, cookieSecure } from './config/env.js';
import { AppError, type FieldError } from './infra/errors.js';
import { loggerOptions } from './infra/logger.js';
import type { Database } from './infra/prisma.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { SESSION_COOKIE } from './modules/auth/session.service.js';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { leadRoutes } from './modules/leads/lead.routes.js';
import { webhookRoutes } from './modules/webhooks/webhook.routes.js';

export interface AppDependencies {
  readonly config: AppConfig;
  readonly db: Database;
  /**
   * Contadores do rate limit compartilhados entre réplicas da API. Opcional: sem ele, os contadores
   * ficam em memória (testes, réplica única). Se o Redis cair, o rate limit é ignorado (fail-open)
   * em vez de derrubar a ingestão de leads.
   */
  readonly redis?: Redis;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const BODY_LIMIT_BYTES = 64 * 1024;

function errorBody(code: string, message: string, details?: readonly FieldError[]) {
  return { success: false as const, error: { code, message, ...(details ? { details } : {}) } };
}

export type App = Awaited<ReturnType<typeof buildApp>>;

export async function buildApp({ config, db, redis }: AppDependencies) {
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

  // Headers de segurança. A API só responde JSON; o Swagger UI usa CSP com hashes estáticos.
  await app.register(helmet, { global: true });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    ...(redis ? { redis, nameSpace: 'eld-rate-limit:' } : {}),
    skipOnError: true,
    errorResponseBuilder: (_request, context) =>
      new AppError(429, 'RATE_LIMITED', `Too many requests, retry in ${context.after}`),
  });

  app.decorateRequest('user', null);

  // CSRF: a sessão é um cookie SameSite=Strict, e as rotas só aceitam JSON (formulário HTML entre
  // sites não consegue enviar). Como defesa extra, uma requisição que altera dados e carrega o
  // cookie de sessão precisa vir da origem do dashboard.
  app.addHook('onRequest', async (request) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    if (!request.headers.cookie?.includes(`${SESSION_COOKIE}=`)) return;
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== config.APP_ORIGIN) {
      throw new AppError(403, 'CSRF_REJECTED', 'Cross-origin request rejected');
    }
  });

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
  await app.register(swaggerUi, { routePrefix: '/api/docs', staticCSP: true });

  await app.register(healthRoutes, { db });
  await app.register(leadRoutes, { db, rateLimitPerMinute: config.RATE_LIMIT_LEADS_PER_MINUTE });
  await app.register(webhookRoutes, {
    db,
    secrets: config.CALLCENTER_WEBHOOK_SECRETS,
    rateLimitPerMinute: config.RATE_LIMIT_WEBHOOK_PER_MINUTE,
  });
  await app.register(authRoutes, {
    db,
    ttlHours: config.SESSION_TTL_HOURS,
    secureCookie: cookieSecure(config),
    loginRateLimitPerMinute: config.RATE_LIMIT_LOGIN_PER_MINUTE,
  });
  await app.register(dashboardRoutes, {
    db,
    ttlHours: config.SESSION_TTL_HOURS,
    timezone: config.REPORTING_TIMEZONE,
  });
  await app.register(adminRoutes, { db, ttlHours: config.SESSION_TTL_HOURS });

  return app;
}
