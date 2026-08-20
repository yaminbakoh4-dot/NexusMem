import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../git/exec.js';
import { extractImportSpecifiers } from './extract.js';
import { extractGoImportSpecifiers } from './extract-go.js';
import { extractJavaImportSpecifiers } from './extract-java.js';
import { extractPhpIncludeSpecifiers } from './extract-php.js';
import { extractPythonImportSpecifiers } from './extract-python.js';
import { extractRustModSpecifiers } from './extract-rust.js';
import { resolveSpecifier } from './resolve.js';
import { parseGoModulePath, resolveGoSpecifier } from './resolve-go.js';
import { resolveJavaSpecifier } from './resolve-java.js';
import { resolvePhpSpecifier } from './resolve-php.js';
import { resolvePythonSpecifier } from './resolve-python.js';
import { resolveRustModSpecifier } from './resolve-rust.js';
import type { FileEdge } from './types.js';

/** Tracked-only, same reasoning as `docs/read.ts`: `git ls-files` already excludes `node_modules`/`.git`/`.nexusmem` for free. Exported so callers reporting "which extensions" never drift from what's actually scanned. */
export const TRACKED_PATHSPECS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.py', '*.go', '*.rs', '*.java', '*.php'];

export interface StructureScan {
  edges: FileEdge[];
  filesScanned: number;
  /** Tracked paths that could not be read this run -- same meaning as `docs/read.ts`'s `unreadable`. */
  unreadable: string[];
}

/** Every real edge `path`'s content produces, dispatched by extension. Go and Java wildcard imports return 0..N targets per import (a whole package); every other language returns 0..1. */
function resolveTargets(path: string, content: string, trackedPaths: ReadonlySet<string>, goModulePath: string | null): string[] {
  if (path.endsWith('.py')) {
    return extractPythonImportSpecifiers(content)
      .map((s) => resolvePythonSpecifier(path, s, trackedPaths))
      .filter((t): t is string => t !== null);
  }
  if (path.endsWith('.rs')) {
    return extractRustModSpecifiers(content)
      .map((s) => resolveRustModSpecifier(path, s, trackedPaths))
      .filter((t): t is string => t !== null);
  }
  if (path.endsWith('.go')) {
    if (!goModulePath) return [];
    return extractGoImportSpecifiers(content).flatMap((imp) => resolveGoSpecifier(goModulePath, imp, trackedPaths));
  }
  if (path.endsWith('.java')) {
    return extractJavaImportSpecifiers(content).flatMap((s) => resolveJavaSpecifier(s, trackedPaths));
  }
  if (path.endsWith('.php')) {
    return extractPhpIncludeSpecifiers(content)
      .map((s) => resolvePhpSpecifier(path, s, trackedPaths))
      .filter((t): t is string => t !== null);
  }
  return extractImportSpecifiers(content)
    .map((s) => resolveSpecifier(path, s, trackedPaths))
    .filter((t): t is string => t !== null);
}

/**
 * Walk every tracked JS/TS/Python/Go/Rust/Java/PHP file, extract its import
 * specifiers, and resolve each against the tracked-path set. A full rescan
 * every call -- there is no cheap incremental cursor for "which files
 * changed their imports," so the caller (`syncStructure`) always replaces
 * the whole snapshot rather than diffing it.
 */
export async function collectFileEdges(repoRoot: string): Promise<StructureScan> {
  const out = await git(repoRoot, ['ls-files', '--', ...TRACKED_PATHSPECS]);
  const paths = out
    .split('\n')
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean);
  const trackedPaths = new Set(paths);

  let goModulePath: string | null = null;
  try {
    goModulePath = parseGoModulePath(await readFile(join(repoRoot, 'go.mod'), 'utf8'));
  } catch {
    goModulePath = null; // no go.mod -- fine for a non-Go repo, or one with no Go imports to resolve
  }

  const edges: FileEdge[] = [];
  const seenEdges = new Set<string>();
  const unreadable: string[] = [];

  for (const path of paths) {
    let content: string;
    try {
      content = await readFile(join(repoRoot, path), 'utf8');
    } catch {
      unreadable.push(path);
      continue;
    }

    for (const target of resolveTargets(path, content, trackedPaths, goModulePath)) {
      if (target === path) continue;

      const key = `${path} ${target}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({ fromPath: path, toPath: target, kind: 'import' });
    }
  }

  return { edges, filesScanned: paths.length, unreadable };
}
