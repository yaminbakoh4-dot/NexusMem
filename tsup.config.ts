import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'cli/index': 'src/cli/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  sourcemap: true,
  // better-sqlite3 is a native addon; it must stay external and be resolved at runtime.
  external: ['better-sqlite3'],
  banner: { js: '#!/usr/bin/env node' },
});
