import { GitError, gitStream } from './exec.js';
import { RECORD_SEP, splitRecords, UNIT_SEP, unquoteGitPath } from './parse.js';

/**
 * Reading and parsing of commit *patches*, as opposed to `log.ts`'s commit
 * metadata + `--numstat` summary.
 *
 * The two are deliberately separate walks rather than one `git log -p
 * --numstat` call. Combining them puts the numstat block and the patch in the
 * same trailing field, where a diff line such as `-1\t2\tfoo` is
 * indistinguishable from a real numstat row -- the commit collector would then
 * invent file entries out of a diff of any tab-separated file. The cost is one
 * extra `git log` process per sync; the benefit is that neither parser has to
 * guess which kind of line it is looking at.
 */

export const GIT_DIFF_LOG_FORMAT = '%x1e%H%x1f%h%x1f%aI%x1f%s%x1f';

/** 4 format fields + the trailing patch block. */
const FIELD_COUNT = 5;

export type FileDiffStatus = 'added' | 'deleted' | 'renamed' | 'modified';

export interface RawFileDiff {
  /** Repo-relative path, post-rename. */
  path: string;
  /** Set only when this file was renamed or copied in this commit. */
  previousPath?: string;
  status: FileDiffStatus;
  /** git printed `Binary files ... differ` (or a binary patch) instead of hunks. */
  binary: boolean;
  insertions: number;
  deletions: number;
  hunkCount: number;
  /** The unified-diff hunks for this file, without the `diff --git`/`index` preamble. */
  patch: string;
}

export interface RawCommitDiff {
  sha: string;
  shortSha: string;
  /** ISO-8601 with offset (`%aI`), matching the commit node's `ts`. */
  authoredAt: string;
  subject: string;
  files: RawFileDiff[];
}

export interface ReadCommitDiffsOptions {
  /** Revision to walk back from. Default `HEAD`. */
  rev?: string;
  /** Exclusive lower bound -- walks `<afterCommit>..<rev>`. Used for incremental sync. */
  afterCommit?: string | null;
  /** Any git date expression, e.g. `90.days.ago` or `2025-01-01`. */
  since?: string | null;
  /** Hard cap on commits walked. Diffs are far bulkier than commit messages, so callers normally set one. */
  maxCount?: number | null;
  /** Context lines around each hunk. Default 3, git's own default. */
  contextLines?: number;
  /** Restrict to pathspecs. */
  paths?: string[];
}

/** Errors that just mean "there is nothing to read", not "something broke". */
const EMPTY_HISTORY = /does not have any commits yet|unknown revision|bad revision|ambiguous argument/i;

export function buildDiffLogArgs(opts: ReadCommitDiffsOptions = {}): string[] {
  const { rev = 'HEAD', afterCommit, since, maxCount, contextLines = 3, paths } = opts;

  const args = [
    'log',
    `--format=${GIT_DIFF_LOG_FORMAT}`,
    '--patch',
    '--no-color',
    // A merge produces no patch at all unless `-m`/`--cc` is passed, and the
    // combined diff those print is a different format from the one parsed
    // here. Excluding merges up front keeps the parser honest about what it
    // supports; the merge itself is still remembered as a `git_commit` node.
    '--no-merges',
    '--find-renames',
    // Never run a user-configured textconv filter: it would execute an
    // arbitrary program from repo config during a sync, and its output is not
    // the diff we claim to be indexing.
    '--no-textconv',
    `--unified=${Math.max(0, contextLines)}`,
  ];

  if (maxCount && maxCount > 0) args.push(`--max-count=${maxCount}`);
  if (since) args.push(`--since=${since}`);

  args.push(afterCommit ? `${afterCommit}..${rev}` : rev);

  if (paths?.length) args.push('--', ...paths);

  return args;
}

/** Walk commit patches, yielding one commit's file diffs at a time. */
export async function* readCommitDiffs(
  cwd: string,
  opts: ReadCommitDiffsOptions = {},
): AsyncGenerator<RawCommitDiff> {
  const args = buildDiffLogArgs(opts);
  let buffer = '';

  try {
    for await (const chunk of gitStream(cwd, args)) {
      buffer += chunk;
      const { records, rest } = splitRecords(buffer);
      buffer = rest;
      for (const record of records) {
        const commit = parseCommitDiffRecord(record);
        if (commit) yield commit;
      }
    }
  } catch (err) {
    if (err instanceof GitError && EMPTY_HISTORY.test(err.stderr)) return;
    throw err;
  }

  for (const record of splitRecords(buffer, true).records) {
    const commit = parseCommitDiffRecord(record);
    if (commit) yield commit;
  }
}

export function parseCommitDiffRecord(record: string): RawCommitDiff | null {
  let payload = record;
  while (payload.startsWith(RECORD_SEP)) payload = payload.slice(RECORD_SEP.length);

  const parts = payload.split(UNIT_SEP);
  if (parts.length < FIELD_COUNT) return null;

  const sha = parts[0] ?? '';
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return null;

  // Same defence as `parseCommitRecord`: a subject containing a literal US
  // would add fields, and everything between it and the final block still
  // belongs to the subject rather than to the patch.
  const patchBlock = parts[parts.length - 1] ?? '';
  const subject = parts.slice(3, parts.length - 1).join(UNIT_SEP).trim();

  return {
    sha,
    shortSha: parts[1] ?? '',
    authoredAt: parts[2] ?? '',
    subject,
    files: parseFileDiffs(patchBlock),
  };
}

const FILE_HEADER = 'diff --git ';
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * Split one commit's patch into per-file diffs.
 *
 * Section boundaries are `diff --git` lines at column 0. A hunk body can never
 * produce one: every line inside a hunk carries a ` `, `+`, `-` or `\` prefix,
 * so an added line reading `diff --git ...` arrives as `+diff --git ...`.
 */
export function parseFileDiffs(block: string): RawFileDiff[] {
  const files: RawFileDiff[] = [];
  let section: string[] | null = null;

  const flush = () => {
    if (!section) return;
    const parsed = parseFileSection(section);
    if (parsed) files.push(parsed);
    section = null;
  };

  for (const raw of block.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith(FILE_HEADER)) {
      flush();
      section = [line];
    } else if (section) {
      section.push(line);
    }
  }
  flush();

  return files;
}

function parseFileSection(lines: string[]): RawFileDiff | null {
  let status: FileDiffStatus = 'modified';
  let binary = false;
  let fromPath: string | null = null;
  let toPath: string | null = null;
  let renamedFrom: string | null = null;
  let hunkStart = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    if (HUNK_HEADER.test(line)) {
      hunkStart = i;
      break;
    }

    if (line.startsWith('new file mode')) status = 'added';
    else if (line.startsWith('deleted file mode')) status = 'deleted';
    else if (line.startsWith('rename from ')) renamedFrom = unquoteGitPath(line.slice('rename from '.length));
    else if (line.startsWith('rename to ')) status = 'renamed';
    else if (line.startsWith('copy from ')) renamedFrom = unquoteGitPath(line.slice('copy from '.length));
    else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) binary = true;
    else if (line.startsWith('--- ')) fromPath = stripDiffPathPrefix(line.slice(4));
    else if (line.startsWith('+++ ')) toPath = stripDiffPathPrefix(line.slice(4));
  }

  const header = parseDiffGitPaths(lines[0] ?? '');
  const path = toPath ?? header.b ?? fromPath ?? header.a;
  if (!path) return null;

  const previousPath = renamedFrom ?? (status === 'renamed' ? (fromPath ?? header.a ?? undefined) : undefined);

  // Nothing textual to index: a binary blob, or a metadata-only change (mode
  // bits, a pure rename). The commit node already records that the file was
  // touched, so dropping these costs no information.
  if (binary || hunkStart === -1) {
    return {
      path,
      ...(previousPath && previousPath !== path ? { previousPath } : {}),
      status,
      binary,
      insertions: 0,
      deletions: 0,
      hunkCount: 0,
      patch: '',
    };
  }

  const hunkLines = lines.slice(hunkStart);
  let insertions = 0;
  let deletions = 0;
  let hunkCount = 0;

  for (const line of hunkLines) {
    if (HUNK_HEADER.test(line)) hunkCount += 1;
    else if (line.startsWith('+')) insertions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }

  return {
    path,
    ...(previousPath && previousPath !== path ? { previousPath } : {}),
    status,
    binary: false,
    insertions,
    deletions,
    hunkCount,
    patch: hunkLines.join('\n').trimEnd(),
  };
}

/** `--- a/src/foo.ts` → `src/foo.ts`; `--- /dev/null` → `null`. */
function stripDiffPathPrefix(raw: string): string | null {
  const cleaned = unquoteGitPath(raw.trim());
  if (cleaned === '/dev/null') return null;
  return cleaned.replace(/^[ab]\//, '');
}

/**
 * Best-effort paths from a `diff --git a/x b/y` line.
 *
 * Only used when the `---`/`+++` lines are absent, which happens for binary
 * and metadata-only changes -- both of which are dropped anyway, so this is a
 * label for a skipped file rather than the identity of an indexed one. An
 * unquoted path containing ` b/` is genuinely ambiguous in this format; git
 * quotes the awkward cases, and the quoted form is parsed exactly.
 */
export function parseDiffGitPaths(headerLine: string): { a: string | null; b: string | null } {
  const rest = headerLine.slice(FILE_HEADER.length);

  if (rest.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest);
    if (match) {
      return { a: stripDiffPathPrefix(match[1] ?? ''), b: stripDiffPathPrefix(match[2] ?? '') };
    }
  }

  const quotedSecond = /^(\S+)\s+("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quotedSecond) {
    return { a: stripDiffPathPrefix(quotedSecond[1] ?? ''), b: stripDiffPathPrefix(quotedSecond[2] ?? '') };
  }

  const split = / b\//.exec(rest);
  if (!split || split.index <= 0) return { a: null, b: null };

  return {
    a: stripDiffPathPrefix(rest.slice(0, split.index)),
    b: stripDiffPathPrefix(rest.slice(split.index + 1)),
  };
}
