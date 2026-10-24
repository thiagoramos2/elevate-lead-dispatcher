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
    // Bound how long a request can wait for a connection or hold a lock-waiting statement.
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  });
  return new PrismaClient({ adapter });
}
