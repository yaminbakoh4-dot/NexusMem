import { sha256Hex } from './ids.js';

/**
 * Normalise a git remote URL so that the same repo yields the same id whether
 * it was cloned over ssh, https, with or without a `.git` suffix.
 *
 *   git@github.com:acme/Repo.git  ->  github.com/acme/repo
 *   https://github.com/acme/repo  ->  github.com/acme/repo
 */
export function normalizeGitUrl(url: string): string {
  let s = url.trim();

  // scp-like syntax: [user@]host:path
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(s);
  if (scp && !s.includes('://')) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    s = s.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
  }

  return s
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

export interface ProjectIdentity {
  /** Absolute path to the repo root on this machine. */
  root: string;
  originUrl?: string | null;
}

/**
 * Stable identity for a project.
 *
 * Prefers the origin URL so that the same repo checked out twice (or on two
 * machines) shares a memory namespace; falls back to the absolute path for
 * repos with no remote.
 */
export function makeProjectId({ root, originUrl }: ProjectIdentity): string {
  const basis = originUrl ? `remote:${normalizeGitUrl(originUrl)}` : `path:${root.replace(/\\/g, '/').toLowerCase()}`;
  return sha256Hex(basis).slice(0, 16);
}
