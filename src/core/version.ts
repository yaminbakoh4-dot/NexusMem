import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Read straight from package.json rather than a literal, so a reported
 * version cannot drift from what was actually published -- which is exactly
 * what happened to the literals this replaces: 0.1.1 shipped with the CLI's
 * `--version` and the MCP server's `initialize` response both still reporting
 * 0.1.0, because the release only bumped package.json.
 *
 * `../../package.json` resolves correctly from both the source location
 * (`src/<subdir>/*.ts`, dev via tsx) and the built location
 * (`dist/cli/index.js`, published), since tsup bundles every entry to the
 * same two-levels-deep location either way. npm always includes package.json
 * in a published tarball regardless of the `files` field, so this is safe to
 * rely on post-publish too.
 */
export function readOwnVersion(): string {
  const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
}
