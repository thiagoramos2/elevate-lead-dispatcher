import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Os testes importam o código-fonte do contracts direto, para nunca rodarem contra um build desatualizado.
const alias = {
  '@elevate/contracts': fileURLToPath(
    new URL('../../packages/contracts/src/index.ts', import.meta.url),
  ),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/integration/setup/global-setup.ts'],
          // Um Postgres e um Redis compartilhados por todos os arquivos; os arquivos rodam um de
          // cada vez e cada um parte de um estado limpo. A concorrência é exercitada *dentro* dos testes.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
