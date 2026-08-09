import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sharedSrc = fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url));

/**
 * Two projects:
 *  - `unit` runs fast, in-process tests and aliases `@riftfront/shared` to its source so
 *    no build step is needed while iterating.
 *  - `integration` boots a real server process and drives it with real clients, so it
 *    deliberately consumes the built `dist` output instead.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: { '@riftfront/shared': sharedSrc },
        },
        test: {
          name: 'unit',
          environment: 'node',
          // Client tests are included, but only for the parts of the client that hold no
          // rendering code — the decoration plan and the surface lookup are plain data,
          // which is exactly why they live in their own modules.
          include: [
            'packages/**/src/**/*.test.ts',
            'apps/server/src/**/*.test.ts',
            'apps/client/src/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // The integration suite binds a real port; running files in parallel would
          // make them fight over it.
          fileParallelism: false,
        },
      },
    ],
  },
});
