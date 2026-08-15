import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The stdio integration test builds the root CLI and spawns real git --
    // same rationale as the root project's own vitest.config.ts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
