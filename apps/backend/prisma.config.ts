import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// O Prisma 7 não lê mais o .env sozinho. O desenvolvimento local usa o .env da raiz do repo;
// os containers recebem variáveis de ambiente reais e não têm arquivo .env.
const rootEnv = new URL('../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  // Opcional para o `prisma generate` funcionar no build da imagem, sem banco.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
