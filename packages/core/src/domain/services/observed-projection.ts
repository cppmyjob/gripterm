import { ObservedState } from '../entities/observed-state';
import { isHookEvent } from '../events/terminal-event';
import type { SessionId } from '../entities/session-id';
import type { StateTransition, TerminalStateMachine } from './terminal-state-machine';
import type { TerminalEvent } from '../events/terminal-event';

/**
 * What each event says about the tool a terminal is running.
 *
 * A total record rather than a `switch`, so that a new member of `TerminalEvent`
 * breaks the build here and has to decide -- without the unreachable `default`
 * branch a `switch` would need in order to say the same thing.
 *
 *   * `name`  -- this event puts a tool in front of the user;
 *   * `clear` -- the tool has finished, or the turn, session or process is over;
 *   * `keep`  -- the event says nothing about tools either way.
 */
const TOOL_RULES: Readonly<Record<TerminalEvent['kind'], 'clear' | 'keep' | 'name'>> = {
  SessionStart: 'clear',
  SessionEnd: 'clear',
  UserPromptSubmit: 'clear',
  PreToolUse: 'name',
  PostToolUse: 'clear',
  PostToolUseFailure: 'clear',
  PermissionRequest: 'name',
  Notification: 'keep',
  Stop: 'clear',
  StopFailure: 'clear',
  CwdChanged: 'keep',
  ResumeTimedOut: 'keep',
  ProcessGone: 'clear',
  TerminalClosed: 'clear',
  LaunchExitedNonZero: 'clear',
  ResumeExitedNonZero: 'clear',
};

export interface ObservedAfterParams {
  readonly previous: ObservedState;
  readonly event: TerminalEvent;
  readonly transition: StateTransition;
  /** When the event happened: the clock for a live event, the journal's stamp for a replayed one. */
  readonly at: Date;
}

/**
 * Observed state after one event.
 *
 * Extracted from `SessionRegistry` rather than copied into the projector,
 * because a second copy of these rules is a second answer to "what does
 * `PreToolUse` mean", and the two would disagree exactly where nobody looks: a
 * terminal restored from its journal would show a different tool, or a different
 * last message, from the one the live window showed a minute earlier.
 *
 * The moment is a parameter for the same reason. The live path stamps the
 * window's clock and the replay stamps what the journal recorded, and a function
 * that reached for a clock of its own could not serve both.
 */
export function observedAfter(params: ObservedAfterParams): ObservedState {
  const { previous, event, transition } = params;
  return ObservedState.create({
    state: transition.kind === 'moved' ? transition.to : transition.state,
    lastEventAt: params.at,
    currentTool: toolAfter(event, previous.currentTool),
    lastAssistantMessage: messageAfter(event, previous.lastAssistantMessage),
    // Neither has any other producer than the statusline forwarder (M1.8a), and
    // `pid` comes from the gateway. Resetting them on every event would make
    // those channels look broken.
    cost: previous.cost,
    contextWindow: previous.contextWindow,
    pid: previous.pid,
  });
}

/**
 * The snapshot of a record whose process is being started right now -- a new
 * terminal, or a conversation being resumed (M2.11).
 *
 * It exists because a restored record arrives from the store wearing whatever it
 * was doing when its window died, and three separate rules downstream ask
 * whether it is `launching`: a non-zero exit is a FAILED restore only from there
 * (§4.3), the resume timeout applies only from there, and the silence watch arms
 * only for it. A record restored as `working` would therefore fail silently in
 * all three -- so the stamp is applied by the one method that makes it true,
 * rather than by each caller remembering to.
 *
 * What it keeps is as deliberate as what it clears. The conversation is the same
 * one it always was, so its last words, its cost and its context are still the
 * truth about it until the resumed process says otherwise. The tool is not: that
 * tool stopped when the process running it did. And the pid least of all -- it is
 * a number from a previous life, which on Windows some unrelated process may hold
 * by now, and everything downstream that asks "is it still running" would be
 * asking about a stranger.
 */
export function observedAtStart(previous: ObservedState, at: Date): ObservedState {
  return ObservedState.create({
    state: 'launching',
    lastEventAt: at,
    currentTool: null,
    lastAssistantMessage: previous.lastAssistantMessage,
    cost: previous.cost,
    contextWindow: previous.contextWindow,
    pid: null,
  });
}

/** One event of a history, with the moment the journal recorded for it. */
export interface ProjectedEvent {
  readonly event: TerminalEvent;
  readonly at: Date;
}

export interface ProjectionParams {
  readonly from: ObservedState;
  /** The conversation the replay starts in. Events from another one are not applied. */
  readonly sessionId: SessionId;
  readonly events: readonly ProjectedEvent[];
  readonly machine: TerminalStateMachine;
}

export interface Projection {
  readonly observed: ObservedState;
  /** Events that moved or held the state. */
  readonly applied: number;
  /** Events the state machine refused -- a late hook after a witnessed end, say. */
  readonly ignored: number;
  /** Events belonging to a conversation this record was not having at the time. */
  readonly foreign: number;
}

/**
 * A history, folded back into the state it left behind.
 *
 * Pure: no clock, no store, no logger. Every moment comes from the events
 * themselves, which is what makes replaying a journal produce the same answer
 * today and tomorrow -- and what makes the test for it a table rather than a
 * rehearsal with fakes in it.
 *
 * Two things it does NOT do, said here because both are easy to assume:
 *
 *   * It cannot see the events that never travelled over the hook transport --
 *     `TerminalClosed`, `ProcessGone` and the other synthetic ones are the
 *     window's own knowledge and are not in the journal. A replay therefore ends
 *     where the last HOOK left the terminal, which is the honest answer for a
 *     record whose process is gone anyway: what the conversation was doing, not
 *     whether it is still running.
 *   * It does not rename the record. The conversation it follows is tracked so
 *     that events from a session this terminal had left are not applied (§4.6),
 *     but the id is deliberately not returned: only the aggregate may decide
 *     which of its session ids is current, and a replay is not that decision.
 */
export function projectObserved(params: ProjectionParams): Projection {
  let observed = params.from;
  let sessionId = params.sessionId;
  let applied = 0;
  let ignored = 0;
  let foreign = 0;

  for (const entry of params.events) {
    const { event } = entry;
    if (isHookEvent(event)) {
      if (event.kind === 'SessionStart') {
        // The one hook that announces a beginning, so it is the one that decides
        // which conversation the events after it belong to -- `/clear`,
        // `--fork-session` and a resume onto another conversation all arrive
        // this way (§4.6).
        sessionId = event.sessionId;
      } else if (!event.sessionId.equals(sessionId)) {
        foreign += 1;
        continue;
      }
    }

    const transition = params.machine.apply(observed.state, event);
    if (transition.kind === 'ignored') {
      // Nothing is written, not even the time. A record whose clock moved for
      // events it refused makes "nothing has happened here for ten minutes"
      // unreadable -- the same rule the live path keeps.
      ignored += 1;
      continue;
    }

    observed = observedAfter({ previous: observed, event, transition, at: entry.at });
    applied += 1;
  }

  return { observed, applied, ignored, foreign };
}

function toolAfter(event: TerminalEvent, previous: string | null): string | null {
  const rule = TOOL_RULES[event.kind];
  if (rule === 'keep') {
    return previous;
  }
  // A `name` event whose `tool_name` was absent still means a tool is running;
  // it is the one we were not told the name of, and never the previous one --
  // showing a finished tool as the running one is a lie with no expiry.
  return rule === 'name' && 'toolName' in event ? event.toolName : null;
}

function messageAfter(event: TerminalEvent, previous: string | null): string | null {
  if (event.kind === 'Stop') {
    // A missing detail never costs what we already know, which is the parser's
    // rule carried through to the store.
    return event.lastAssistantMessage ?? previous;
  }
  if (event.kind === 'SessionStart') {
    // A new conversation does not inherit the previous one's last words.
    return null;
  }
  return previous;
}
