/**
 * A single shell command event, normalized by whichever strategy read it.
 *
 * Strategies differ wildly in how much they know: the opt-in hook has exact
 * timestamps, cwd and exit code; the zero-config fallbacks (PSReadLine,
 * bash/zsh history files) often have none of that. Every field below except
 * `command` and `naturalKey` can be approximate or absent -- callers must
 * check `tsApprox` and the nullable fields rather than assume hook-quality
 * data.
 */
export interface RawShellEntry {
  /**
   * Stable id component, owned by the strategy that produced this entry.
   *
   * Each strategy picks the id policy that fits its own guarantees: the hook
   * log has high-precision timestamps it controls, so `ts + command hash` is
   * safe; scrape-based history files have no such guarantee, so they mix in
   * a position component too. See collectors/shell-history.ts.
   */
  naturalKey: string;
  command: string;
  /** ISO-8601. Real if `tsApprox` is false, synthesized (but ordered) otherwise. */
  ts: string;
  tsApprox: boolean;
  exitCode: number | null;
  cwd: string | null;
  durationMs: number | null;
  /** 'pwsh' | 'pwsh-hook' | 'bash' | 'zsh' -- becomes the `shell:<name>` node source. */
  shell: string;
}
