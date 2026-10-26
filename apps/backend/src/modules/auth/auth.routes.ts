import { errorResponseSchema, loginSchema, sessionResponseSchema } from '@elevate/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../infra/errors.js';
import type { Database } from '../../infra/prisma.js';
import { currentUser, requireUser } from './guards.js';
import { login, logout, SESSION_COOKIE } from './session.service.js';

export interface AuthRoutesOptions {
  readonly db: Database;
  readonly ttlHours: number;
  readonly secureCookie: boolean;
  readonly loginRateLimitPerMinute: number;
}

export const authRoutes: FastifyPluginAsyncZod<AuthRoutesOptions> = async (app, options) => {
  const { db, ttlHours, secureCookie } = options;

  app.post(
    '/api/auth/login',
    {
      // Limite por IP contra brute force e credential stuffing; o bloqueio por conta fica no serviço.
      config: { rateLimit: { max: options.loginRateLimitPerMinute, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        summary: 'Log in and start a session (HttpOnly cookie)',
        body: loginSchema,
        response: {
          200: sessionResponseSchema,
          401: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await login(db, request.body.email, request.body.password, ttlHours);
      if (!result) {
        // Mesma resposta para e-mail inexistente, senha errada e conta bloqueada.
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid e-mail or password');
      }
      reply.setCookie(SESSION_COOKIE, result.token, {
        httpOnly: true,
        secure: secureCookie,
        sameSite: 'strict',
        path: '/',
        expires: result.expiresAt,
      });
      request.log.info({ userId: result.user.id, role: result.user.role }, 'user logged in');
      return { user: result.user };
    },
  );

  app.post(
    '/api/auth/logout',
    { schema: { tags: ['auth'], response: { 204: z.null() } } },
    async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE];
      if (token) await logout(db, token);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/api/auth/me',
    {
      preHandler: requireUser(db, ttlHours),
      schema: {
        tags: ['auth'],
        response: { 200: sessionResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) => ({ user: currentUser(request) }),
  );
};
