import { z } from 'zod';
import { userRoleSchema } from './enums.js';

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  // Limite superior evita custo de hash arbitrário com senhas gigantes.
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** Usuário autenticado como a API o expõe. Nunca inclui hash de senha nem dados da sessão. */
export const sessionUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: userRoleSchema,
  callCenterId: z.uuid().nullable(),
  callCenterName: z.string().nullable(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const sessionResponseSchema = z.object({ user: sessionUserSchema });
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
