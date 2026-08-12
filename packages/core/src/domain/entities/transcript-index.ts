/**
 * Which conversations have a transcript on this machine.
 *
 * The one thing the restore predicate cannot ask the CLI for. A session that
 * never received a prompt leaves no transcript at all -- measured 2026-08-10:
 * the `projects/` directory is not even created, though `session-env/<sessionId>`
 * is -- and `claude --resume` on such an id exits 1 immediately with "No
 * conversation found with session ID". Without this input every editor restart
 * would produce a batch of false `resume_failed` for terminals a person opened
 * and never typed into.
 *
 * A union for the same reason as `AgentListing`: **a scan that failed must never
 * arrive as an empty index.** Empty means "nothing has ever been said in these
 * conversations", which is a legitimate and common answer; failure means we do
 * not know, and the two must not be one value. What they share is the direction
 * they push -- both keep records out of the plan -- but they are different
 * sentences to a person and only one of them is a fault.
 */
export type TranscriptIndex =
  | {
    readonly kind: 'indexed';
    /** `SessionId.value` of every conversation with a transcript. */
    readonly sessionIds: ReadonlySet<string>;
    /** Project directories that could not be listed, and are therefore invisible here. */
    readonly skipped: number;
  }
  | { readonly kind: 'unavailable', readonly reason: string };
