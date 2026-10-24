import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export type Database = PrismaClient;

export interface DatabaseOptions {
  readonly url: string;
  readonly poolMax: number;
}

export function createDatabase({ url, poolMax }: DatabaseOptions): Database {
  const adapter = new PrismaPg({
    connectionString: url,
    max: poolMax,
    // Limita quanto tempo uma requisição pode esperar por conexão ou manter um statement esperando lock.
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  });
  return new PrismaClient({ adapter });
}
