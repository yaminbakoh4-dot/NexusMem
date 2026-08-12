/**
 * One exchange from an AI coding assistant conversation: a human turn plus
 * whatever prose the assistant said back (tool calls and internal reasoning
 * are deliberately excluded -- see claude-code-reader.ts for why).
 */
export interface RawConversationTurn {
  /** Stable id component, owned by the reader that produced this turn. */
  naturalKey: string;
  /** The human's message, verbatim. */
  userText: string;
  /** The assistant's prose reply, concatenated across its text blocks. */
  assistantText: string;
  /** ISO-8601, taken from the user message's own timestamp. */
  ts: string;
  /** Working directory at the time, if the source recorded one. */
  cwd: string | null;
  /** Source identity, e.g. `claude-code`. Becomes `conversation:<source>`. */
  source: string;
  /**
   * Which session this exchange belongs to, e.g. `claude-code:<uuid>`.
   *
   * The per-turn collector has no use for this -- each of its nodes is
   * deliberately self-contained. It exists for the session summarizer, which
   * needs to know where one working session ends and the next begins, and
   * cannot recover that from timestamps alone (two sessions can interleave
   * on the same repository).
   */
  sessionKey: string;
}
