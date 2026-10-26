import type { SessionUser, UserRole } from '@elevate/contracts';
import type { FastifyRequest } from 'fastify';
import { forbidden, unauthenticated } from '../../infra/errors.js';
import type { Database } from '../../infra/prisma.js';
import { authenticate, SESSION_COOKIE } from './session.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Preenchido pelo guard `requireUser`; nunca vem do cliente. */
    user: SessionUser | null;
  }
}

/**
 * preHandler que exige uma sessão válida. A autorização é sempre feita aqui no backend: esconder
 * botões no frontend não protege nada (seção 21 do enunciado).
 */
export function requireUser(db: Database, ttlHours: number, roles?: readonly UserRole[]) {
  return async (request: FastifyRequest) => {
    const token = request.cookies[SESSION_COOKIE];
    const user = token ? await authenticate(db, token, ttlHours) : null;
    if (!user) throw unauthenticated();
    if (roles && !roles.includes(user.role)) throw forbidden();
    request.user = user;
  };
}

/** Usuário autenticado de uma rota protegida por `requireUser`. */
export function currentUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw unauthenticated();
  return request.user;
}

/**
 * Escopo de dados do usuário: OPERATOR só enxerga o próprio call center; ADMIN enxerga tudo (null).
 * Vem da sessão, nunca de parâmetro do cliente.
 */
export function callCenterScope(user: SessionUser): string | null {
  if (user.role === 'admin') return null;
  if (!user.callCenterId) throw forbidden();
  return user.callCenterId;
}
