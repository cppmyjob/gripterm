import { ValidationError } from '../errors/gripterm-error';
import type { SessionId } from '../entities/session-id';

/**
 * Everything that can move a terminal's state.
 *
 * The union has two halves, and the second one is not optional. Four of the
 * eleven states -- `ended`, `orphaned`, `degraded`, `resume_failed` -- are not
 * reached by anything an agent reports: they follow from what the runner itself
 * observes, and leaving them out would give the state machine an exhaustive
 * `switch` over an incomplete alphabet. That is worse than no `switch` at all,
 * because it reads as proof of completeness.
 *
 * **Every name here is a sentence about AN agent, not about one CLI.** The
 * words a particular agent uses for these facts -- Claude Code's
 * `hook_event_name`, whatever the next one turns out to send -- live under
 * `domain/agents/<name>/`, together with the table that translates them
 * (`hook-vocabulary.ts`). This file is what the state machine, the projection
 * and the panel are allowed to know, and none of them can tell whose CLI is on
 * the other end.
 */
export type TerminalEvent = AgentEvent | SyntheticEvent;

/**
 * Reported by the agent itself and delivered to the HTTP endpoint.
 *
 * First-hand evidence, which is what makes these rank above anything the runner
 * merely infers (see `TerminalStateMachine`).
 */
export type AgentEvent =
  | ConversationStartedEvent
  | ConversationEndedEvent
  | PromptSubmittedEvent
  | ToolStartedEvent
  | ToolFinishedEvent
  | ToolFailedEvent
  | PermissionRequestedEvent
  | AgentNotifiedEvent
  | TurnFinishedEvent
  | TurnFailedEvent
  | SubagentStartedEvent
  | SubagentFinishedEvent
  | WorkingDirectoryChangedEvent;

/** Produced by the runner from its own observation. */
export type SyntheticEvent =
  | ResumeTimedOutEvent
  | WentQuietEvent
  | ProcessGoneEvent
  | TerminalClosedEvent
  | LaunchExitedNonZeroEvent
  | ResumeExitedEvent;

/**
 * `'other'` is ours, not the CLI's: an unrecognised value collapses into it
 * rather than failing the parse. A future build adding a seventh source must
 * not stop a terminal from being observed, and every source leads to the same
 * transition anyway. The raw payload is the ingest log's business.
 *
 * NOT YET NEUTRAL, and said here rather than left to be found: these six words
 * are Claude Code's `source` values carried through unchanged. Nothing in this
 * build branches on more than their presence, so they cost nothing today; the
 * day a second agent arrives with its own list, the translator is where they
 * become ours -- the same seam the event names have already crossed.
 */
export type ConversationStartSource = 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | 'other';

/**
 * Why a conversation ended.
 *
 * NOT YET NEUTRAL, for the same reason and with the same remedy as
 * `ConversationStartSource`. From the payload field `reason` -- NOT `source`,
 * which reads back undefined.
 */
export type ConversationEndReason =
  | 'clear'
  | 'resume'
  | 'logout'
  | 'prompt_input_exit'
  | 'bypass_permissions_disabled'
  | 'other';

/**
 * The ten literals build 2.1.225 actually emits, plus our `'other'`.
 *
 * A bare `permission_prompt` is NOT among them. The string exists in the
 * binary's pool, but never as a notification type -- the prefixed forms belong
 * to other subsystems. An earlier design waited for permission on this event;
 * that edge was dead, and `PermissionRequested` is the only reliable producer.
 *
 * NOT YET NEUTRAL, as above: three of these eleven decide a phase
 * (`NOTIFICATION_PHASE` in the state machine) and the rest only prove the
 * process is alive.
 */
export type AgentNoticeType =
  | 'agent_completed'
  | 'agent_needs_input'
  | 'auth_success'
  | 'computer_use_enter'
  | 'computer_use_exit'
  | 'elicitation_complete'
  | 'elicitation_response'
  | 'idle_prompt'
  | 'push_notification'
  | 'worker_permission_prompt'
  | 'other';

/**
 * Fields every agent report carries.
 *
 * `sessionId` is the only one that is required. It is what the registry
 * compares against the entry's own id to notice that `/clear` started a new
 * conversation -- the comparison is with `entry.sessionId`, never with the
 * terminal id in the URL, which would differ always rather than on drift.
 */
export interface AgentEventContext {
  readonly sessionId: SessionId;
  readonly promptId: string | null;
  readonly cwd: string | null;
  /** Where the conversation is recorded. The restore predicate needs it: a session that never received a prompt has no transcript at all. */
  readonly transcriptPath: string | null;
}

export interface ConversationStartedEvent extends AgentEventContext {
  readonly kind: 'ConversationStarted';
  readonly source: ConversationStartSource;
}

export interface ConversationEndedEvent extends AgentEventContext {
  readonly kind: 'ConversationEnded';
  readonly reason: ConversationEndReason;
}

export interface PromptSubmittedEvent extends AgentEventContext {
  readonly kind: 'PromptSubmitted';
  readonly userInput: string | null;
}

export interface ToolStartedEvent extends AgentEventContext {
  readonly kind: 'ToolStarted';
  readonly toolName: string | null;
  readonly toolUseId: string | null;
}

export interface ToolFinishedEvent extends AgentEventContext {
  readonly kind: 'ToolFinished';
  readonly toolName: string | null;
  readonly toolUseId: string | null;
}

export interface ToolFailedEvent extends AgentEventContext {
  readonly kind: 'ToolFailed';
  readonly toolName: string | null;
  readonly toolUseId: string | null;
  readonly errorMessage: string | null;
}

/** The only reliable producer of `waiting_permission`. */
export interface PermissionRequestedEvent extends AgentEventContext {
  readonly kind: 'PermissionRequested';
  readonly toolName: string | null;
  readonly permissionLevel: string | null;
}

export interface AgentNotifiedEvent extends AgentEventContext {
  readonly kind: 'AgentNotified';
  readonly notificationType: AgentNoticeType;
  readonly message: string | null;
}

export interface TurnFinishedEvent extends AgentEventContext {
  readonly kind: 'TurnFinished';
  /** From `last_assistant_message`, which the CLI provides precisely so that nobody parses a transcript. */
  readonly lastAssistantMessage: string | null;
}

export interface TurnFailedEvent extends AgentEventContext {
  readonly kind: 'TurnFailed';
  readonly errorType: string | null;
  readonly errorMessage: string | null;
}

/**
 * A subagent the main agent started has begun.
 *
 * Registered because of what `TurnFinished` turned out NOT to mean (customer,
 * measured 2026-08-21): the CLI runs Task subagents in the background, so the
 * main agent's turn ENDS the moment it has launched them -- the turn reported
 * finished at 25.7 s while two subagents ran until 109 s -- and a terminal that
 * showed `idle` for those eighty seconds was answering the wrong question.
 * `agentId` is what makes the pairing possible: the same run reported five
 * subagents finishing for ids nothing ever started, so a counter would have
 * gone to zero with the work still going.
 */
export interface SubagentStartedEvent extends AgentEventContext {
  readonly kind: 'SubagentStarted';
  readonly agentId: string | null;
  readonly agentType: string | null;
}

/** One of those subagents has finished. Ignored unless it names one we saw start. */
export interface SubagentFinishedEvent extends AgentEventContext {
  readonly kind: 'SubagentFinished';
  readonly agentId: string | null;
  readonly agentType: string | null;
}

export interface WorkingDirectoryChangedEvent extends AgentEventContext {
  readonly kind: 'WorkingDirectoryChanged';
  /** Field names measured on 2.1.225: `old_cwd` / `new_cwd`. `previous_cwd` occurs zero times in the binary. */
  readonly oldCwd: string | null;
  readonly newCwd: string | null;
}

/** Restoring took too long, and we no longer know what the process is doing. */
export interface ResumeTimedOutEvent {
  readonly kind: 'ResumeTimedOut';
}

/** The sweep found a record claiming work that nothing has been heard from. */
export interface WentQuietEvent {
  readonly kind: 'WentQuiet';
}

/** Reconciliation found the record but not the process. */
export interface ProcessGoneEvent {
  readonly kind: 'ProcessGone';
  readonly pid: number | null;
}

/** The editor closed the terminal, and `exitStatus.code` was undefined -- the person closed it. */
export interface TerminalClosedEvent {
  readonly kind: 'TerminalClosed';
}

export interface LaunchExitedNonZeroEvent {
  readonly kind: 'LaunchExitedNonZero';
  readonly exitCode: number;
}

/**
 * A restored terminal's agent process exited before the conversation began.
 *
 * The only one of the three death events that does NOT ask what the code was.
 * Under `launch` the code is the whole question -- zero is a person typing
 * `/exit` and nothing was lost. Under `resume` the person asked for a
 * conversation they already had, so a process that ended before that
 * conversation ever announced itself did not bring it back, and the number it
 * ended with does not change that.
 */
export interface ResumeExitedEvent {
  readonly kind: 'ResumeExited';
  readonly exitCode: number;
}

const AGENT_EVENT_KINDS: ReadonlySet<string> = new Set<AgentEvent['kind']>([
  'ConversationStarted',
  'ConversationEnded',
  'PromptSubmitted',
  'ToolStarted',
  'ToolFinished',
  'ToolFailed',
  'PermissionRequested',
  'AgentNotified',
  'TurnFinished',
  'TurnFailed',
  'SubagentStarted',
  'SubagentFinished',
  'WorkingDirectoryChanged',
]);

/** True for events that carry a session id -- the ones the registry checks for drift. */
export function isAgentEvent(event: TerminalEvent): event is AgentEvent {
  return AGENT_EVENT_KINDS.has(event.kind);
}

export function resumeTimedOut(): ResumeTimedOutEvent {
  return Object.freeze({ kind: 'ResumeTimedOut' });
}

export function wentQuiet(): WentQuietEvent {
  return Object.freeze({ kind: 'WentQuiet' });
}

export function processGone(pid: number | null): ProcessGoneEvent {
  if (pid !== null && (!Number.isInteger(pid) || pid <= 0)) {
    throw new ValidationError('pid must be a positive integer or null', { details: { pid } });
  }
  return Object.freeze({ kind: 'ProcessGone', pid });
}

export function terminalClosed(): TerminalClosedEvent {
  return Object.freeze({ kind: 'TerminalClosed' });
}

/**
 * A new terminal's agent process exited with a non-zero code.
 *
 * There are two events for a non-zero exit rather than one, and it is forced: a
 * fresh launch and a restore both sit in `launching`, yet they end in different
 * states -- `ended` with a `launch_failed` signal against `resume_failed`. One
 * event name would map to two mutually exclusive outcomes, and the pair
 * (state, event) holds nothing to choose between them. The producer knows,
 * because it knows the `LaunchIntent` it started with, so the producer names
 * the event.
 */
export function launchExitedNonZero(exitCode: number): LaunchExitedNonZeroEvent {
  return Object.freeze({ kind: 'LaunchExitedNonZero', exitCode: assertNonZeroExit(exitCode) });
}

/**
 * As `launchExitedNonZero`, for a restore -- and it accepts a zero, which is
 * the one asymmetry between the pair.
 *
 * Measured 2026-08-25: over 34 live runs of the resume-refusal scenario under
 * the EDITOR engine, `vscode.Terminal.exitStatus.code` came back 0 once for a
 * `claude` that exits 1, while the same process under our own engine -- which
 * reads the code off the child itself -- reported 1 on all 40 runs. So the code
 * on this path is a number another program hands us, and a rule that turns on
 * it turns on something we do not own. The state does not need it: what makes
 * this a failed restore is that the process ended while the record was still
 * `launching`, and the caller establishes that before calling.
 */
export function resumeExited(exitCode: number): ResumeExitedEvent {
  if (!Number.isInteger(exitCode)) {
    throw new ValidationError('an exit event needs an integer exit code', {
      details: { exitCode },
    });
  }
  return Object.freeze({ kind: 'ResumeExited', exitCode });
}

/** An event named "exited non-zero" that carries a zero is a lie, so it is refused at the door. */
function assertNonZeroExit(exitCode: number): number {
  if (!Number.isInteger(exitCode) || exitCode === 0) {
    throw new ValidationError('a non-zero exit event needs a non-zero integer exit code', {
      details: { exitCode },
    });
  }
  return exitCode;
}
