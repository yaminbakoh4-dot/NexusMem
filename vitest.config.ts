import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Runs before every test file: redirects the user-scoped NexusMem
    // directory into a temporary one. See tests/setup.ts for why.
    setupFiles: ['tests/setup.ts'],
  },
});
