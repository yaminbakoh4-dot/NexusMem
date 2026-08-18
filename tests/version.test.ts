import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readOwnVersion } from '../src/core/version.js';

/**
 * Pins the exact regression `readOwnVersion`'s own comment documents: 0.1.1
 * shipped with `--version` and the MCP `initialize` response both still
 * reporting 0.1.0, because a literal had been bumped in one place and not the
 * other. Reading straight from package.json makes that class of drift
 * unrepresentable -- this test is what keeps it that way.
 */
describe('readOwnVersion', () => {
  it('matches package.json, not a literal that could drift from it', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

    expect(readOwnVersion()).toBe(pkg.version);
  });

  it('returns a non-empty semver-shaped string', () => {
    expect(readOwnVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
