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
 * Whether the record says, on first-hand evidence, that the conversation is
 * over.
 *
 * Exported because a second reader appeared with M2.8 and the alternative was a
 * second copy of the set. `ObservabilityWatch` asks the same question this
 * machine asks, for the opposite purpose: the machine refuses a late hook here,
 * while the watch reads "an event arrived anyway" as proof that the row is
 * wrong. Two copies of the pair would eventually disagree about a third state,
 * and the disagreement would show up as a warning nobody could reproduce.
 */
export function isWitnessedEnd(state: PersistedTerminalState): boolean {
  return WITNESSED_DEAD.has(state);
}

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
const QUIET_ELSEWHERE = 'silence contradicts a claim of work, and nothing else claims it';
const SHUTDOWN_BEFORE_START = 'the CLI shutting down says nothing about whether the start got going';

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
  public apply(
    current: PersistedTerminalState,
    event: TerminalEvent,
    running: readonly string[] = []
  ): StateTransition {
    switch (event.kind) {
      // Note the missing `phase()` guard: this is the resurrection edge. After
      // `/clear` the CLI sends `SessionEnd(reason: clear)` and then a
      // `SessionStart(source: clear)` carrying a NEW session id, so an entry
      // that refused to leave `ended` would be stranded by the user's own
      // `/clear`. The registry's business is the id; the state is this edge.
      case 'SessionStart':
        return settle(current, 'idle');

      // The one pair where a first-hand hook is refused, and the refusal is
      // this narrow on purpose.
      //
      // A45, measured 2026-08-20 against CLI 2.1.233 under a real pty: a resume
      // of a conversation that is not there sends exactly ONE hook --
      // `SessionEnd`, at about 1.6 s -- and then exits with code 1 at about
      // 3.15 s. Its `reason` is `other`, which is also the value an unrecognised
      // one collapses into, so the payload cannot be made to tell this case from
      // an ordinary end. Settled on that hook, the record is `ended` when the
      // exit code arrives, `death` refuses it as late, and `resume_failed` --
      // the state M2.13 turns into an offer to start the conversation over --
      // never happens on the path that needs the offer most.
      //
      // `launching` is the only state in which "the CLI shut down" and "the
      // start got going" are different questions, so it is the only state where
      // the hook is not allowed to answer.
      //
      // THE PRICE: a record whose CLI says goodbye and then does not exit sits
      // in `launching`. It is bounded on both paths and by different clocks --
      // the restore timeout at 20 s (`ResumeTimedOut` -> `degraded`) and the
      // reconciliation sweep at 30 s (`ProcessGone` -> `orphaned`) -- so the
      // longest a row can hold a start that is over is one sweep.
      // REMOVED WHEN: a build ships a `SessionEnd` payload that distinguishes
      // "this session never started" (a `reason` of its own), at which point the
      // hook can settle the record and carry the distinction with it.
      case 'SessionEnd':
        return current === 'launching'
          ? ignored(current, SHUTDOWN_BEFORE_START)
          : phase(current, 'ended');

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
        if (named === undefined) {
          return proofOfLife(current);
        }
        // `idle_prompt` and `agent_completed` are the main agent back at its
        // prompt, and measured to arrive while its subagents are still going
        // (85.7 s against subagents that finished at 107 s). Same rule as
        // `Stop`: they are the truth about the agent, not about the terminal.
        return phase(current, named === 'idle' && running.length > 0 ? 'working' : named);
      }

      // Settling events, and what they settle INTO is the whole of the
      // customer's fifth complaint (2026-08-21). `Stop` is the main agent
      // saying it has finished speaking, and measured against a real CLI that
      // happens the moment it has LAUNCHED its background subagents -- the two
      // in that run went on working for eighty seconds afterwards. So idle is
      // "nobody is running", not "the main agent stopped", and who is running
      // is counted outside this machine and handed in.
      case 'Stop':
      case 'SubagentStop':
        return phase(current, running.length === 0 ? 'idle' : 'working');

      // A subagent beginning is first-hand evidence of work, exactly as a tool
      // starting is.
      case 'SubagentStart':
        return phase(current, 'working');

      case 'StopFailure':
        return phase(current, 'turn_failed');

      case 'CwdChanged':
        return proofOfLife(current);

      // Rank 3. The timeout only ever asked one question -- "did the restore
      // ever start?" -- so anywhere but `launching` it has already been answered
      // by something better, and answering it again would undo the answer.
      // Rank 3, and the narrowest rule in this table: nothing arrived. It is
      // worth a transition against exactly one state -- `working` is the only
      // one that CLAIMS something is happening -- and all it can do is take the
      // claim away. What replaced it is not known, and `degraded` is the state
      // that says so.
      //
      // A50 (measured 2026-08-20) is why the event exists at all: an
      // interrupted turn produces NOTHING from the CLI -- not one of the
      // thirty-one hooks its binary carries -- so a row left to itself says
      // `working` until the person's next turn in that terminal. `idle` is what
      // usually happened and is still a guess about another program's insides;
      // this event refuses to make it.
      case 'WentQuiet':
        return current === 'working'
          ? settle(current, 'degraded')
          : ignored(current, QUIET_ELSEWHERE);

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
