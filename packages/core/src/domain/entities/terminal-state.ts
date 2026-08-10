/**
 * Every answer to "what is this terminal doing right now".
 *
 * `degraded` and `resume_failed` are states rather than flags: both answer that
 * same question. `degraded` means "the process may well be alive, but we do not
 * know its state" -- and expressing ignorance by the absence of a flag is how
 * one forgets to handle it.
 */
export type TerminalState =
  | 'launching'
  | 'idle'
  | 'working'
  | 'waiting_permission'
  | 'waiting_input'
  | 'turn_failed'
  | 'ended'
  | 'orphaned'
  | 'detached'
  | 'degraded'
  | 'resume_failed';

/**
 * What may be produced by the state machine and written to disk -- everything
 * except `detached`.
 *
 * `detached` is computed by the reader from the owner's heartbeat and laid over
 * the stored state at display time. It is never persisted, because only a
 * foreign process could write it into a file it does not own, and single-writer
 * is the rule the whole store rests on. Excluding it from the type makes that
 * checkable rather than remembered: `detached` can neither enter the state
 * machine nor be saved, and the exhaustive `switch` is unharmed.
 *
 * It also makes the overlay free to undo -- once the heartbeat is fresh again
 * it simply stops applying, with no reverse transition and no write.
 */
export type PersistedTerminalState = Exclude<TerminalState, 'detached'>;
