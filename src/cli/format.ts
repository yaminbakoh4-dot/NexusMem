import pc from 'picocolors';

/**
 * Shared rendering for the `scan-*` commands.
 *
 * These commands all print one line per candidate node, led by its signal, so
 * a user can eyeball what a collector would ingest before committing to a
 * sync. The signal column previously existed as four near-identical private
 * copies, which had already drifted: three graded high signal green while
 * `scan-shell` graded it red, so the same column meant opposite things
 * depending on which command produced it.
 */

/**
 * Cutoffs for the three signal bands, per source.
 *
 * These stay per-source on purpose. Collectors do not score on a shared
 * scale -- a commit's conventional-commit type is much stronger evidence than
 * a command's shape, so `scoreShellCommand` clusters near the middle while
 * git commits use the full range. One global cutoff would paint every shell
 * entry the same color and say nothing.
 */
export interface SignalBands {
  /** At or above this, the signal is high for this source. */
  high: number;
  /** At or above this (but below `high`), middling. */
  medium: number;
}

export const GIT_SIGNAL_BANDS: SignalBands = { high: 0.7, medium: 0.45 };
export const SHELL_SIGNAL_BANDS: SignalBands = { high: 0.6, medium: 0.4 };
export const CONVERSATION_SIGNAL_BANDS: SignalBands = { high: 0.55, medium: 0.35 };
export const DOCS_SIGNAL_BANDS: SignalBands = { high: 0.55, medium: 0.35 };

export type SignalBand = 'high' | 'medium' | 'low';

/**
 * Which band a signal falls in, given its source's cutoffs.
 *
 * Split out from the coloring so the threshold logic is assertable: under a
 * non-TTY test runner picocolors emits no escape codes, which would make a
 * test of the rendered string blind to exactly the kind of divergence this
 * module exists to prevent.
 */
export function signalBand(signal: number, bands: SignalBands): SignalBand {
  if (signal >= bands.high) return 'high';
  if (signal >= bands.medium) return 'medium';
  return 'low';
}

/**
 * The one place a band becomes a color.
 *
 * Being a single map is the actual fix for the drift: a per-source palette is
 * now unrepresentable rather than merely discouraged, so "high is green" holds
 * for every command by construction. Thresholds vary by source; the color
 * language does not.
 */
const BAND_COLOR: Record<SignalBand, (s: string) => string> = {
  high: pc.green,
  medium: pc.yellow,
  low: pc.dim,
};

/** A node's signal as a fixed-width, color-graded figure. */
export function formatSignal(signal: number, bands: SignalBands): string {
  return BAND_COLOR[signalBand(signal, bands)](signal.toFixed(2));
}
