import { ValidationError } from '../errors/gripterm-error';
import type { PersistedTerminalState } from '../entities/terminal-state';
import type { NotificationType, TerminalEvent } from '../events/terminal-event';

/**
 * What the attention notifier reacts to on entry into a state.
 *
 * It is the target state's name in every case but one: a non-zero exit while
 * still `launching` is named `launch_failed` rather than `ended`, because bare
 * `ended` is also produced by a person closing their own terminal, and a toast
 * on the user's own deliberate action is noise. The from-state is the only
 * thing that separates the two, and this machine is the only place that has it.
 */
export type AttentionSignal = PersistedTerminalState | 'launch_failed';

/** The event was applied and it named a different state. */
export interface MovedTransition {
  readonly kind: 'moved';
  readonly from: PersistedTerminalState;
  readonly to: PersistedTerminalState;
  readonly signal: AttentionSignal;
}

/** The event was applied and the state it names is the one we are already in. */
export interface StayedTransition {
  readonly kind: 'stayed';
  readonly state: PersistedTerminalState;
}

/**
 * The event was NOT applied.
 *
 * Kept apart from `stayed` on purpose. Both leave the state alone, but only one
 * of them means "we dropped something": a late hook after a witnessed end, or a
 * producer emitting an event it had no business emitting from this state.
 * Folded into `stayed`, that would be a silent drop, and a silent drop is
 * exactly the class of defect this machine exists to make visible.
 */
export interface IgnoredTransition {
  readonly kind: 'ignored';
  readonly state: PersistedTerminalState;
  readonly reason: string;
}

export type StateTransition = MovedTransition | StayedTransition | IgnoredTransition;

/**
 * States reached by witnessing, not by inference: `SessionEnd` arrived, or the
 * editor destroyed the terminal object. `orphaned` and `degraded` are NOT here
 * -- both are the runner's own guesses (a PID lookup, a timeout), and a hook
 * event is first-hand evidence that overrules a guess.
 */
const WITNESSED_DEAD: ReadonlySet<PersistedTerminalState> = new Set<PersistedTerminalState>([
  'ended',
  'resume_failed',
]);

/**
 * The notification types that name a phase. Every other type -- and there are
 * seven more -- proves the process is alive without saying what it is doing.
 *
 * `permission_prompt` is deliberately absent: it is not a value the CLI emits.
 * The edge that once waited for permission on it was dead, and `waiting_permission`
 * has exactly one reliable producer, `PermissionRequest`.
 */
const NOTIFICATION_PHASE: Partial<Record<NotificationType, PersistedTerminalState>> = {
  agent_needs_input: 'waiting_input',
  idle_prompt: 'idle',
  agent_completed: 'idle',
};

const LATE_HOOK = 'a witnessed end is not undone by a mid-turn hook';
const LATE_INFERENCE = 'the process already reported what it is doing';
const ALREADY_DEAD = 'this terminal already has a witnessed cause of death';

/**
 * `(state, event) -> state`. The whole of what a terminal's state depends on.
 *
 * Transitions are derived from three ranked sources of knowledge rather than
 * listed edge by edge, and the ranking is the design:
 *
 *   1. A **hook** is first-hand evidence that the CLI is alive and in a named
 *      phase. It overrides anything the runner merely inferred.
 *   2. A **death witness** -- the editor telling us the terminal object is gone
 *      -- is first-hand too, and settles the matter.
 *   3. The runner's **inferences** (a resume timeout, a PID that is no longer
 *      there) are the weakest. They apply only where nothing better is known.
 *
 * On top of that, one rule that is worth stating alone because it covers two
 * whole rows of the table: **in `ended` and `resume_failed`, `SessionStart` is
 * the only event that changes anything.** `SessionStart` is the one hook that
 * announces a beginning -- which is how `/clear` gets back out of `ended` --
 * and every other hook describes the middle of a turn, so arriving after an end
 * it is by construction late.
 *
 * The rules are here; the table is in the test, written out cell by cell and
 * independently. That separation is the point: a machine implemented as a table
 * and checked against a copy of that table proves nothing at all.
 */
export class TerminalStateMachine {
  public apply(current: PersistedTerminalState, event: TerminalEvent): StateTransition {
    switch (event.kind) {
      // Note the missing `phase()` guard: this is the resurrection edge. After
      // `/clear` the CLI sends `SessionEnd(reason: clear)` and then a
      // `SessionStart(source: clear)` carrying a NEW session id, so an entry
      // that refused to leave `ended` would be stranded by the user's own
      // `/clear`. The registry's business is the id; the state is this edge.
      case 'SessionStart':
        return settle(current, 'idle');

      case 'SessionEnd':
        return phase(current, 'ended');

      // Absolute, not "stays `working`". These three arrive only while a turn is
      // running, so they are evidence of `working` whatever we believed before
      // -- and that is the only way out of `waiting_permission`, which
      // `PermissionRequest` can enter but nothing else can leave until `Stop`.
      // A relative target left an approved tool running under the label "waiting
      // for permission" for the rest of the turn, and suppressed the second
      // permission toast with it.
      case 'UserPromptSubmit':
      case 'PreToolUse':
      case 'PostToolUse':
      case 'PostToolUseFailure':
        return phase(current, 'working');

      case 'PermissionRequest':
        return phase(current, 'waiting_permission');

      case 'Notification': {
        const named = NOTIFICATION_PHASE[event.notificationType];
        return named === undefined ? proofOfLife(current) : phase(current, named);
      }

      case 'Stop':
        return phase(current, 'idle');

      case 'StopFailure':
        return phase(current, 'turn_failed');

      case 'CwdChanged':
        return proofOfLife(current);

      // Rank 3. The timeout only ever asked one question -- "did the restore
      // ever start?" -- so anywhere but `launching` it has already been answered
      // by something better, and answering it again would undo the answer.
      case 'ResumeTimedOut':
        return current === 'launching'
          ? settle(current, 'degraded')
          : ignored(current, LATE_INFERENCE);

      case 'ProcessGone':
        return WITNESSED_DEAD.has(current)
          ? ignored(current, ALREADY_DEAD)
          : settle(current, 'orphaned');

      case 'TerminalClosed':
        return death(current, 'ended', 'ended');

      case 'LaunchExitedNonZero':
        return death(current, 'ended', current === 'launching' ? 'launch_failed' : 'ended');

      // The one place where the target depends on the from-state: a restore that
      // never reached `SessionStart` leaves a record worth offering to start
      // over (`resume_failed`); one that got going and died later is just over.
      case 'ResumeExitedNonZero':
        return current === 'launching'
          ? death(current, 'resume_failed', 'resume_failed')
          : death(current, 'ended', 'ended');

      default: {
        // Unreachable while the union is covered -- adding a member breaks the
        // build here. It still throws rather than guessing, because the only
        // way to arrive is a cast, and a cast is a defect upstream.
        const unhandled: never = event;
        throw new ValidationError('unhandled terminal event', { details: { event: unhandled } });
      }
    }
  }
}

/** A hook that names a phase. Rank 1, and blocked only by a witnessed end. */
function phase(current: PersistedTerminalState, to: PersistedTerminalState): StateTransition {
  return WITNESSED_DEAD.has(current) ? ignored(current, LATE_HOOK) : settle(current, to);
}

/**
 * A hook that proves the process is alive but names no phase.
 *
 * From `orphaned` this is not a no-op: "there is no process" has just been
 * disproved, and `degraded` -- alive, phase unknown -- is the honest successor.
 * From `degraded` it really is a no-op, because we still do not know the phase.
 */
function proofOfLife(current: PersistedTerminalState): StateTransition {
  if (WITNESSED_DEAD.has(current)) {
    return ignored(current, LATE_HOOK);
  }
  return settle(current, current === 'orphaned' ? 'degraded' : current);
}

/**
 * The editor says the terminal object is gone.
 *
 * A second death event for one terminal is a producer bug -- the lifecycle
 * service emits exactly one, chosen by the `LaunchIntent` it was called with --
 * so it is named rather than absorbed.
 */
function death(
  current: PersistedTerminalState,
  to: PersistedTerminalState,
  signal: AttentionSignal
): StateTransition {
  return WITNESSED_DEAD.has(current) ? ignored(current, ALREADY_DEAD) : settle(current, to, signal);
}

/** The single place where "moved" and "stayed" are told apart. */
function settle(
  current: PersistedTerminalState,
  to: PersistedTerminalState,
  signal: AttentionSignal = to
): StateTransition {
  return current === to
    ? { kind: 'stayed', state: current }
    : { kind: 'moved', from: current, to, signal };
}

function ignored(current: PersistedTerminalState, reason: string): StateTransition {
  return { kind: 'ignored', state: current, reason };
}
