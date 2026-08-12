import type { SessionId } from './session-id';

/**
 * One agent CLI session running on this machine, as the CLI itself reports it.
 *
 * Not a terminal of ours and not a record of ours: this is the machine's own
 * answer to "what is running", which is the only thing that can tell a dead
 * owner (an editor window that went away) from a dead conversation (a `claude`
 * that went with it). The two look identical in our store and differ in what
 * may be done about them -- restoring the second is right, restoring the first
 * is a second `--resume` on a live conversation and an interleaved transcript.
 *
 * **Everything but the id is nullable, and that is measured rather than
 * cautious.** The CLI omits `name` and `status` when it has none, and fills two
 * fields it does not know with placeholders rather than leaving them out
 * (2026-08-12, A24). What arrives as "I do not know" arrives here as `null`, so
 * that no consumer has to learn the CLI's spelling of ignorance.
 *
 * `kind` and `status` stay strings. The documented vocabularies -- `interactive`
 * / `background`, `working` / `blocked` / `waiting` -- are not measured on this
 * machine beyond `interactive` and `busy`, and a union assembled from
 * documentation is a promise nobody made.
 */
export interface AgentRecord {
  /** The conversation. The one field a record without which is nothing to us. */
  readonly sessionId: SessionId;
  /** The CLI process, when the CLI named one. Always a positive integer here. */
  readonly pid: number | null;
  /** The working directory of the session, or `null` when the CLI does not know it. */
  readonly cwd: string | null;
  /** `interactive` on every session measured so far; the CLI's word, unnarrowed. */
  readonly kind: string | null;
  /** Unix milliseconds, or `null` when the CLI does not know when it began. */
  readonly startedAt: number | null;
  /** The display name the CLI carries for the session, when it has one. */
  readonly name: string | null;
  /** `busy` on every session measured so far; the CLI's word, unnarrowed. */
  readonly status: string | null;
}

/**
 * What this machine says is running -- or why it did not say.
 *
 * A union, and the single most load-bearing type decision of the reading side:
 * **an unavailable listing must never arrive as an empty one.** The consumer of
 * this value decides whether to start `claude --resume` on a conversation, and
 * an empty list reads as "nothing is running, go ahead". Silence read as
 * permission is how a live conversation gets a second process attached to it,
 * which the CLI's own documentation describes as interleaved messages in one
 * transcript -- and nothing takes that back afterwards.
 *
 * `skipped` counts the entries that named no conversation we could use. It is
 * an ordinary sight rather than a fault: a session file with no `sessionId` is
 * printed by the CLI without the key (A24), so those entries exist and cannot
 * be matched against anything of ours. It is counted so that a listing full of
 * them can be noticed instead of merely looking short.
 */
export type AgentListing =
  | {
    readonly kind: 'listed';
    readonly agents: readonly AgentRecord[];
    readonly skipped: number;
  }
  | { readonly kind: 'unavailable', readonly reason: string };
