/**
 * The one line `terminal-in-view` says about resizing, on every run of it.
 *
 * **What it is for, and it is an instrument rather than a claim.** These
 * numbers existed already and only a FAILING run had them: they were assembled
 * inside the `catch` of the wait for ConPTY's acknowledgement, so the only way
 * to collect a sample of them was to wait for red. Measured 2026-08-26 over the
 * 26 full gates in `.gate/receipts.ndjson`, the `live` stage went red 7 times in
 * three days -- a sample of seven, for a question about milliseconds. Said on
 * every run, a GREEN gate is a measurement too, and the sample arrives an order
 * of magnitude sooner.
 *
 * **What it does not do.** It does not say why the resize wait sometimes times
 * out. That is not known (2026-08-26: the orchestrator's hypothesis about the
 * `cursor` stage was refuted by Fisher p = 1.00 over those same receipts, and
 * the bridge's own two deterministic tests passed in the red run). Nothing here
 * changes what any test asserts.
 *
 * **The wording is load-bearing.** The substring "the bridge sent N sizes
 * [...], the page settled at CxR, the pty was spawned at CxR" is what the
 * failure message has carried since 2026-08-21; it is quoted in the plan, in
 * this suite's own comments and in the gate's receipts. It is extended here,
 * never reworded: a rewording would orphan every record that quotes it while
 * appearing to change nothing.
 */

/** The word every line of this kind begins with, so that a grep finds all of them. */
export const RESIZES = 'RESIZES';

/** What one run of the resize wait saw, from both sides of the boundary. */
export interface SizesSeen {
  /** How many sizes the bridge let through to the pty, by its own count. */
  readonly sent: number;
  /** One entry per size that went, with the moment it went. Kept as the strings the suite built. */
  readonly moments: readonly string[];
  /** How long ConPTY took to answer any resize at all, or null where it never did. */
  readonly acknowledgedAfterMs: number | null;
  /** How long the wait ran -- the same number as above when it succeeded, the ceiling when it did not. */
  readonly waitedMs: number;
  /** The size the page came to rest at. */
  readonly settled: { readonly cols: number, readonly rows: number };
  /** The size the pty was started with, which is the size a silent ConPTY leaves it at. */
  readonly spawned: { readonly cols: number, readonly rows: number };
}

function size(of: { readonly cols: number, readonly rows: number }): string {
  return `${String(of.cols)}x${String(of.rows)}`;
}

/**
 * One line, whatever happened -- and the same line in the failure message, so
 * that a red run and a green run are two rows of one table rather than two
 * different records.
 */
export function whatTheSizesDid(seen: SizesSeen): string {
  const answered = seen.acknowledgedAfterMs === null
    ? `acknowledged nothing in ${String(seen.waitedMs)} ms`
    : `acknowledged one after ${String(seen.acknowledgedAfterMs)} ms`;
  return (
    `${RESIZES}: the bridge sent ${String(seen.sent)} sizes [${seen.moments.join(', ')}], ` +
    `the page settled at ${size(seen.settled)}, the pty was spawned at ${size(seen.spawned)}, ` +
    `and the pseudoconsole ${answered}`
  );
}
