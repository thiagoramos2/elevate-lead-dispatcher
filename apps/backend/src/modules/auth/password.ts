import { hash, verify } from '@node-rs/argon2';

// Os padrões da biblioteca são argon2id com m=19 MiB, t=2, p=1: o mínimo recomendado pela OWASP.
// Ficam explícitos para que uma atualização da dependência não os enfraqueça silenciosamente.
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}
