import type { FileTouch } from '../core/types.js';

/**
 * Pure parsing layer for `git log` output. No I/O here, so it is cheap to
 * unit-test against the ugly real-world cases (renames, binaries, messages
 * containing newlines / tabs / arrows).
 */

export const RECORD_SEP = '\x1E';
export const UNIT_SEP = '\x1F';

/**
 * Field order must stay in sync with `parseCommitRecord`.
 *
 * ASCII RS/US are used as delimiters rather than a made-up token: they are
 * control characters that git never emits itself and that essentially never
 * occur in commit messages.
 */
export const GIT_LOG_FORMAT =
  '%x1e%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%s%x1f%B%x1f';

const FIELD_COUNT = 10; // 9 format fields + the trailing --numstat block

export interface RawCommit {
  sha: string;
  shortSha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** ISO-8601 with offset (`%aI`). */
  authoredAt: string;
  committedAt: string;
  subject: string;
  /** Full message including the subject line (`%B`), trimmed. */
  message: string;
  /** Message with the subject line stripped; empty for one-line commits. */
  messageBody: string;
  files: FileTouch[];
  isMerge: boolean;
}

/**
 * Split a stdout buffer into complete records.
 *
 * Returns the trailing partial record so the caller can carry it into the next
 * chunk. `flush` treats whatever remains as complete.
 */
export function splitRecords(buffer: string, flush = false): { records: string[]; rest: string } {
  const parts = buffer.split(RECORD_SEP);
  // parts[0] is whatever preceded the first RS -- empty on a fresh stream.
  const rest = flush ? '' : (parts.pop() ?? '');
  const records = parts.filter((p) => p.trim().length > 0);
  if (flush && rest.trim().length > 0) records.push(rest);
  return { records, rest };
}

export function parseCommitRecord(record: string): RawCommit | null {
  // Tolerate a leading separator so callers can pass raw `git log` slices
  // without going through `splitRecords` first.
  let payload = record;
  while (payload.startsWith(RECORD_SEP)) payload = payload.slice(RECORD_SEP.length);

  const parts = payload.split(UNIT_SEP);
  if (parts.length < FIELD_COUNT) return null;

  const sha = parts[0] ?? '';
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return null;

  // A commit message containing a literal US would add fields; everything
  // between the subject and the final block still belongs to the body.
  const numstatBlock = parts[parts.length - 1] ?? '';
  const message = parts.slice(8, parts.length - 1).join(UNIT_SEP).trim();
  const subject = (parts[7] ?? '').trim();
  const parents = (parts[2] ?? '').trim().split(/\s+/).filter(Boolean);

  return {
    sha,
    shortSha: parts[1] ?? '',
    parents,
    authorName: parts[3] ?? '',
    authorEmail: parts[4] ?? '',
    authoredAt: parts[5] ?? '',
    committedAt: parts[6] ?? '',
    subject,
    message,
    messageBody: stripSubject(message, subject),
    files: parseNumstat(numstatBlock),
    isMerge: parents.length > 1,
  };
}

function stripSubject(message: string, subject: string): string {
  if (!subject || !message.startsWith(subject)) return message;
  return message.slice(subject.length).trim();
}

const NUMSTAT_LINE = /^(\d+|-)\t(\d+|-)\t(.*)$/;

export function parseNumstat(block: string): FileTouch[] {
  const files: FileTouch[] = [];

  for (const line of block.split('\n')) {
    const m = NUMSTAT_LINE.exec(line.trimEnd());
    if (!m) continue;

    const [, addRaw = '', delRaw = '', pathRaw = ''] = m;
    const binary = addRaw === '-' || delRaw === '-';
    const { path, previousPath } = resolveRenamePath(unquoteGitPath(pathRaw));

    const touch: FileTouch = {
      path,
      insertions: binary ? null : Number(addRaw),
      deletions: binary ? null : Number(delRaw),
      binary,
    };
    if (previousPath) touch.previousPath = previousPath;
    files.push(touch);
  }

  return files;
}

/**
 * `--numstat` reports renames in two shapes:
 *   src/{old => new}/file.ts   (shared prefix/suffix factored out)
 *   old/file.ts => new/file.ts (no shared parts)
 */
export function resolveRenamePath(raw: string): { path: string; previousPath?: string } {
  const braced = /^(.*)\{(.*?) => (.*?)\}(.*)$/.exec(raw);
  if (braced) {
    const [, prefix = '', from = '', to = '', suffix = ''] = braced;
    return {
      path: collapseSlashes(prefix + to + suffix),
      previousPath: collapseSlashes(prefix + from + suffix),
    };
  }

  const plain = raw.split(' => ');
  if (plain.length === 2) {
    return { path: (plain[1] ?? '').trim(), previousPath: (plain[0] ?? '').trim() };
  }

  return { path: raw };
}

function collapseSlashes(p: string): string {
  return p.replace(/\/{2,}/g, '/').replace(/^\//, '');
}

/**
 * git still quotes paths containing `"`, backslashes or control characters
 * even with `core.quotePath=false`.
 */
export function unquoteGitPath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const inner = p.slice(1, -1);

  // Octal escapes are raw *bytes*, so decode into a byte buffer and let UTF-8
  // decoding reassemble multi-byte characters.
  const bytes: number[] = [];

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i] ?? '';
    if (ch !== '\\') {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
      continue;
    }

    const esc = inner[i + 1] ?? '';
    const simple: Record<string, number> = { n: 0x0a, t: 0x09, r: 0x0d, a: 0x07, b: 0x08, f: 0x0c, v: 0x0b };
    if (esc in simple) {
      bytes.push(simple[esc] as number);
      i += 1;
    } else if (esc === '"' || esc === '\\') {
      bytes.push(esc.charCodeAt(0));
      i += 1;
    } else if (/[0-7]/.test(esc)) {
      const octal = inner.slice(i + 1, i + 4);
      bytes.push(parseInt(octal, 8) & 0xff);
      i += 3;
    } else {
      bytes.push(0x5c); // lone backslash
    }
  }

  return Buffer.from(bytes).toString('utf8');
}
