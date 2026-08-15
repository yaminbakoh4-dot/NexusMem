/**
 * Pure decision logic for live terminal-failure detection, kept free of the
 * `vscode` import so it can be unit tested directly -- same split as
 * `renderResults.ts`/`recentMemoryRows.ts`. The `vscode.window.
 * onDidEndTerminalShellExecution` wiring that calls these lives in
 * `extension.ts`, where it cannot be unit tested outside a real extension
 * host, matching this project's established boundary.
 */

export interface FailureCandidate {
  /** `undefined` is a real, ambiguous case -- see vscode's own TerminalShellExecutionEndEvent.exitCode doc comment. */
  exitCode: number | undefined;
  commandLine: string;
  /** Mirrors vscode.TerminalShellExecutionCommandLineConfidence's numeric values (Low=0, Medium=1, High=2) without importing vscode. */
  confidence: number;
}

/**
 * Whether a just-finished terminal command is worth checking against
 * NexusMem's memory. Deliberately conservative: an ambiguous exit code
 * (Ctrl+C, a sub-shell, or the shell simply not reporting one -- all
 * indistinguishable here) and low-confidence command-line text (read from
 * terminal-buffer heuristics, not sent explicitly by the shell, so it can be
 * garbled) are both treated as "don't check" rather than guessed at.
 */
export function shouldCheckFailure(candidate: FailureCandidate): boolean {
  if (candidate.exitCode === undefined || candidate.exitCode === 0) return false;
  if (candidate.confidence <= 0) return false;
  return candidate.commandLine.trim().length > 0;
}

export interface SearchOutcome {
  matched: number;
  text: string;
}

/**
 * Whether a background search result is strong enough to interrupt the user
 * with a notification. `matched` alone is not sufficient -- a positive count
 * with blank packed text would be a notification with nothing to show for
 * "Show details".
 */
export function shouldNotify(result: SearchOutcome): boolean {
  return result.matched > 0 && result.text.trim().length > 0;
}

const MAX_NOTIFICATION_COMMAND_LENGTH = 80;

/** Keeps the notification message from growing unboundedly for a long or pasted command. */
export function truncateForNotification(commandLine: string): string {
  const trimmed = commandLine.trim();
  return trimmed.length > MAX_NOTIFICATION_COMMAND_LENGTH
    ? `${trimmed.slice(0, MAX_NOTIFICATION_COMMAND_LENGTH - 1)}…`
    : trimmed;
}
