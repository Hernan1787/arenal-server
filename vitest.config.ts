import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@arenal/domain': src('./packages/domain/src/index.ts'),
      '@arenal/contracts': src('./packages/contracts/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          // Sin base de datos: corren en cualquier máquina con `pnpm test`.
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
          exclude: ['apps/*/test/integration/**'],
        },
      },
      {
        extends: true,
        test: {
          // Contra Postgres real: `docker compose up -d postgres` y luego `pnpm test:integration`.
          name: 'integration',
          include: ['apps/*/test/integration/**/*.test.ts'],
          globalSetup: ['apps/server/test/integration/global-setup.ts'],
          fileParallelism: false,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
