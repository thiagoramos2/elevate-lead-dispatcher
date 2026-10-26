import { randomBytes } from 'node:crypto';
import type { SessionUser } from '@elevate/contracts';
import { sha256Hex } from '../../domain/idempotency.js';
import type { Database } from '../../infra/prisma.js';
import { hashPassword, verifyPassword } from './password.js';

export const SESSION_COOKIE = 'eld_session';

/** Falhas seguidas até a conta ser bloqueada, e por quanto tempo (contra brute force por conta). */
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

/**
 * Hash usado quando o e-mail não existe ou a conta está bloqueada: o argon2 roda do mesmo jeito,
 * então o tempo de resposta não revela se a conta existe (enumeração de usuários).
 */
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => {
  dummyHash ??= hashPassword(randomBytes(32).toString('hex'));
  return dummyHash;
};

type UserRow = {
  id: string;
  email: string;
  role: 'admin' | 'operator';
  call_center_id: string | null;
  call_center_name: string | null;
};

const toSessionUser = (row: UserRow): SessionUser => ({
  id: row.id,
  email: row.email,
  role: row.role,
  callCenterId: row.call_center_id,
  callCenterName: row.call_center_name,
});

/**
 * Autentica e cria uma sessão. Retorna null para qualquer falha (e-mail inexistente, senha errada
 * ou conta bloqueada), sem distinguir os casos para quem chama.
 */
export async function login(
  db: Database,
  email: string,
  password: string,
  ttlHours: number,
): Promise<{ token: string; user: SessionUser; expiresAt: Date } | null> {
  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true, lockedUntil: true },
  });

  if (!user || (user.lockedUntil && user.lockedUntil > new Date())) {
    await verifyPassword(await getDummyHash(), password);
    return null;
  }

  if (!(await verifyPassword(user.passwordHash, password))) {
    // Atômico: falhas concorrentes não se perdem. Ao atingir o limite, bloqueia e zera o contador.
    await db.$executeRaw`
      UPDATE users SET
        locked_until = CASE WHEN failed_logins + 1 >= ${MAX_FAILED_LOGINS}
                            THEN now() + make_interval(mins => ${LOCKOUT_MINUTES}) ELSE locked_until END,
        failed_logins = CASE WHEN failed_logins + 1 >= ${MAX_FAILED_LOGINS} THEN 0 ELSE failed_logins + 1 END,
        updated_at = now()
      WHERE id = ${user.id}::uuid`;
    return null;
  }

  // Token de 256 bits; no banco fica só o hash, então um dump do banco não gera sessões válidas.
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
  await db.$transaction([
    db.user.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null },
    }),
    db.session.create({ data: { tokenHash: sha256Hex(token), userId: user.id, expiresAt } }),
  ]);

  const sessionUser = await findUser(db, user.id);
  if (!sessionUser) throw new Error('user vanished during login');
  return { token, user: sessionUser, expiresAt };
}

async function findUser(db: Database, userId: string): Promise<SessionUser | null> {
  const rows = await db.$queryRaw<UserRow[]>`
    SELECT u.id, u.email, u.role, u.call_center_id, c.name AS call_center_name
    FROM users u LEFT JOIN call_centers c ON c.id = u.call_center_id
    WHERE u.id = ${userId}::uuid`;
  return rows[0] ? toSessionUser(rows[0]) : null;
}

/**
 * Resolve o usuário de um token de sessão válido. A expiração é deslizante: quando passa da metade
 * do tempo de vida, a sessão é renovada.
 */
export async function authenticate(
  db: Database,
  token: string,
  ttlHours: number,
): Promise<SessionUser | null> {
  const tokenHash = sha256Hex(token);
  const rows = await db.$queryRaw<(UserRow & { expires_at: Date })[]>`
    SELECT u.id, u.email, u.role, u.call_center_id, c.name AS call_center_name, s.expires_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN call_centers c ON c.id = u.call_center_id
    WHERE s.token_hash = ${tokenHash} AND s.expires_at > now()`;
  const row = rows[0];
  if (!row) return null;

  const halfLifeMs = (ttlHours * 3600_000) / 2;
  if (row.expires_at.getTime() - Date.now() < halfLifeMs) {
    await db.session.update({
      where: { tokenHash },
      data: { expiresAt: new Date(Date.now() + ttlHours * 3600_000) },
    });
  }
  return toSessionUser(row);
}

export async function logout(db: Database, token: string): Promise<void> {
  await db.session.deleteMany({ where: { tokenHash: sha256Hex(token) } });
}

/** Remove sessões expiradas. Chamado periodicamente pelo worker. */
export async function purgeExpiredSessions(db: Database): Promise<number> {
  return db.$executeRaw`DELETE FROM sessions WHERE expires_at < now()`;
}
