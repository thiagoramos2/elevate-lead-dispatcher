import { hash, verify } from '@node-rs/argon2';

// The library defaults are argon2id with m=19 MiB, t=2, p=1: the OWASP minimum recommendation.
// They are spelled out so a dependency upgrade cannot silently weaken them.
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}
