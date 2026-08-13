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
  | 'unreachable'
  | 'degraded'
  | 'resume_failed';

/**
 * What may be produced by the state machine and written to disk -- everything
 * except the two overlays.
 *
 * `detached` and `unreachable` are computed by the reader from the owner's
 * heartbeat and laid over the stored state at display time. Neither is ever
 * persisted, because only a foreign process could write one into a file it does
 * not own, and single-writer is the rule the whole store rests on. Excluding
 * them from the type makes that checkable rather than remembered: they can
 * neither enter the state machine nor be saved, and the exhaustive `switch` is
 * unharmed.
 *
 * It also makes an overlay free to undo -- once the heartbeat is fresh again it
 * simply stops applying, with no reverse transition and no write.
 *
 * They are two rather than one because the difference is what a person is being
 * asked to decide: `detached` is a window that has gone, `unreachable` is a
 * window that is there and silent, and adopting the second without looking is
 * how one conversation gets two `claude --resume` (M2.14, `AdoptOptions.force`).
 */
export type PersistedTerminalState = Exclude<TerminalState, 'detached' | 'unreachable'>;

/**
 * The same union as values, derived from a record that the compiler forces to
 * be total -- so a state added above cannot fall out of the list below without
 * failing the build.
 *
 * It exists for the one caller that meets these names as untrusted text: the
 * codec reading a record written by another build. The overlays are absent for
 * the same reason they are absent from the type, and a file claiming one is a
 * file refused.
 */
const PERSISTED: Readonly<Record<PersistedTerminalState, true>> = {
  launching: true,
  idle: true,
  working: true,
  waiting_permission: true,
  waiting_input: true,
  turn_failed: true,
  ended: true,
  orphaned: true,
  degraded: true,
  resume_failed: true,
};

export const PERSISTED_TERMINAL_STATES: readonly PersistedTerminalState[] = Object.freeze(
  Object.keys(PERSISTED) as PersistedTerminalState[]
);

export function isPersistedTerminalState(value: string): value is PersistedTerminalState {
  return Object.hasOwn(PERSISTED, value);
}
