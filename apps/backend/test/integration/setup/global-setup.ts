import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

const backendDir = fileURLToPath(new URL('../../../', import.meta.url));
const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');

/**
 * Sobe containers reais de Postgres 18 e Redis 8 uma vez para o projeto de integração e aplica as
 * mesmas migrations da produção. Sem mocks: o comportamento de locks e constraints é o que importa.
 */
export default async function setup(project: TestProject) {
  let postgres: StartedPostgreSqlContainer | undefined;
  let redis: StartedRedisContainer | undefined;

  try {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer('postgres:18-alpine').start(),
      new RedisContainer('redis:8-alpine').start(),
    ]);

    const databaseUrl = postgres.getConnectionUri();
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: backendDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    project.provide('databaseUrl', databaseUrl);
    project.provide('redisUrl', redis.getConnectionUrl());
  } catch (error) {
    await Promise.allSettled([postgres?.stop(), redis?.stop()]);
    throw error;
  }

  return async () => {
    await Promise.allSettled([postgres?.stop(), redis?.stop()]);
  };
}
