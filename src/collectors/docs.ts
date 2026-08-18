import { chunkAssistantText } from '../conversation/chunk.js';
import { makeNodeId } from '../core/ids.js';
import { truncate } from '../core/text.js';
import type { MemoryNode } from '../core/types.js';
import type { RawDocFile } from '../docs/types.js';

/**
 * Maps a repo's tracked `.md` files onto MemoryNodes, one per section.
 *
 * The gap this closes was found by dogfooding the live MCP server (see
 * README.md's Phase 3 row): a design-rationale question answered from
 * README.md prose came back empty, because git/shell/conversation are the
 * only sources that were ever read. Chunking reuses `chunkAssistantText`
 * from the conversation collector rather than inventing a second heading
 * splitter -- it already treats literal `#`..`######` lines as section
 * boundaries, which is exactly what a real markdown file is made of (the
 * bold-lead-paragraph case it also handles just never triggers here).
 */

export interface DocsCollectorOptions {
  /** Default 2000 -- final safety cap on one section's body. */
  maxBodyChars?: number;
  /** Default 1200 -- target size for one section chunk before it's split further. */
  maxChunkChars?: number;
}

const DEFAULT_MAX_BODY_CHARS = 2000;
const DEFAULT_MAX_CHUNK_CHARS = 1200;
const MAX_TITLE_CHARS = 200;

const EXPLANATION_MARKERS = /\b(because|the reason|design decision|trade-?off|instead of|rationale|why)\b/i;

/**
 * Prior importance of one doc section.
 *
 * Deliberately close to the middle, like a conversation chunk's score: a
 * doc file mixes genuine design rationale with routine scaffolding (a table
 * of contents entry, a install-step list), and only the source text itself
 * tells them apart.
 */
export function scoreDocSection(path: string, heading: string | null, text: string): number {
  let score = 0.45;

  if (EXPLANATION_MARKERS.test(text)) score += 0.25;
  if (/(^|\/)readme\.md$/i.test(path)) score += 0.1;
  if (heading === null) score -= 0.1; // preamble text with no section of its own
  if (text.length < 80) score -= 0.15;

  return Number(Math.min(1, Math.max(0.05, score)).toFixed(3));
}

function slugify(heading: string | null, index: number): string {
  if (heading === null) return `_preamble-${index}`;
  const slug = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `_section-${index}`;
}

function sectionTitle(path: string, heading: string | null, index: number, count: number): string {
  if (heading) return truncate(`${path} — ${heading}`, MAX_TITLE_CHARS);
  if (count > 1) return truncate(`${path} (part ${index + 1}/${count})`, MAX_TITLE_CHARS);
  return truncate(path, MAX_TITLE_CHARS);
}

export function toMemoryNodes(file: RawDocFile, projectId: string, opts: DocsCollectorOptions = {}): MemoryNode[] {
  const maxBody = opts.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const maxChunk = opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;

  const chunks = chunkAssistantText(file.content, maxChunk);
  if (chunks.length === 0) return [];

  // Stable ids keyed by heading text, not raw index -- a section added
  // earlier in the file must not silently reshuffle every node after it.
  // Duplicate headings (e.g. two "Why" sections) fall back to an occurrence
  // count so they still get distinct, deterministic keys.
  const seenSlugs = new Map<string, number>();

  return chunks.map((chunk, index) => {
    const baseSlug = slugify(chunk.heading, index);
    const occurrence = seenSlugs.get(baseSlug) ?? 0;
    seenSlugs.set(baseSlug, occurrence + 1);
    const naturalKey = occurrence === 0 ? `${file.path}#${baseSlug}` : `${file.path}#${baseSlug}:${occurrence}`;

    return {
      id: makeNodeId(projectId, 'doc_section', naturalKey),
      kind: 'doc_section',
      projectId,
      ts: file.ts,
      source: 'docs',
      title: sectionTitle(file.path, chunk.heading, index, chunks.length),
      body: truncate(chunk.text, maxBody),
      files: [{ path: file.path, insertions: null, deletions: null, binary: false }],
      signal: scoreDocSection(file.path, chunk.heading, chunk.text),
      provenance: 'inferred', // a written claim, and the kind of content most likely to go stale
      meta: {
        path: file.path,
        heading: chunk.heading,
        chunkIndex: index,
        chunkCount: chunks.length,
      },
    };
  });
}

export function collectDocFiles(files: readonly RawDocFile[], projectId: string, opts: DocsCollectorOptions = {}): MemoryNode[] {
  return files.flatMap((file) => toMemoryNodes(file, projectId, opts));
}
