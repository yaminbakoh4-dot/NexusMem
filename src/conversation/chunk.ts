import { truncate } from '../core/text.js';

/**
 * Splits a long assistant reply into topic-sized chunks instead of one node
 * per whole exchange.
 *
 * The acceptance-test failure this fixes was diagnosed against the real
 * database, not guessed: a specific technical explanation was present in
 * the index but buried (and sometimes truncated) inside a single 4000-char
 * node covering several unrelated points. The fix targets how this
 * project's own replies are actually written -- long-form prose with
 * **bold lead sentences** marking each point, not literal `#` markdown
 * headings (those show up in files this assistant writes, like README.md,
 * not in its own chat responses). Both are treated as section boundaries;
 * plain paragraphs accumulate into the current chunk until it would exceed
 * `maxChars`.
 */

export interface AssistantChunk {
  /** The literal heading/bold-lead text that opened this chunk, if any. */
  heading: string | null;
  text: string;
}

const HEADING_LINE = /^#{1,6}\s+(.+)$/;
const BOLD_LEAD = /^\*\*([^*]+?)\*\*/;

/** Returns the section title if `paragraph` opens a new logical section, else null. */
function sectionStart(paragraph: string): string | null {
  const firstLine = paragraph.split('\n')[0] ?? '';
  const heading = HEADING_LINE.exec(firstLine);
  if (heading) return (heading[1] ?? '').trim();

  const bold = BOLD_LEAD.exec(paragraph);
  if (bold) return (bold[1] ?? '').trim();

  return null;
}

export function chunkAssistantText(text: string, maxChars: number): AssistantChunk[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return [];

  const chunks: AssistantChunk[] = [];
  let buffer: string[] = [];
  let bufferHeading: string | null = null;

  const bufferChars = () => buffer.reduce((n, p) => n + p.length, 0) + Math.max(0, buffer.length - 1) * 2;

  const flush = () => {
    if (buffer.length === 0) return;
    chunks.push({ heading: bufferHeading, text: truncate(buffer.join('\n\n'), maxChars) });
    buffer = [];
    bufferHeading = null;
  };

  for (const paragraph of paragraphs) {
    const heading = sectionStart(paragraph);
    const startsNewSection = heading !== null && buffer.length > 0;
    const wouldOverflow = buffer.length > 0 && bufferChars() + 2 + paragraph.length > maxChars;

    if (startsNewSection || wouldOverflow) flush();
    if (heading !== null) bufferHeading = heading;

    buffer.push(paragraph);
  }
  flush();

  return chunks;
}
