import { ValidationError } from '../errors/gripterm-error';
import type { SessionId } from '../entities/session-id';

/**
 * Everything that can move a terminal's state.
 *
 * The union has two halves, and the second one is not optional. Four of the
 * eleven states -- `ended`, `orphaned`, `degraded`, `resume_failed` -- are not
 * reached by any Claude Code hook: they follow from what the runner itself
 * observes, and leaving them out would give the state machine an exhaustive
 * `switch` over an incomplete alphabet. That is worse than no `switch` at all,
 * because it reads as proof of completeness.
 */
export type TerminalEvent = HookEvent | SyntheticEvent;

/** Produced by Claude Code and delivered to the HTTP endpoint. */
export type HookEvent =
  | SessionStartEvent
  | SessionEndEvent
  | UserPromptSubmitEvent
  | PreToolUseEvent
  | PostToolUseEvent
  | PostToolUseFailureEvent
  | PermissionRequestEvent
  | NotificationEvent
  | StopEvent
  | StopFailureEvent
  | CwdChangedEvent;

/** Produced by the runner from its own observation. */
export type SyntheticEvent =
  | ResumeTimedOutEvent
  | ProcessGoneEvent
  | TerminalClosedEvent
  | LaunchExitedNonZeroEvent
  | ResumeExitedNonZeroEvent;

/**
 * `'other'` is ours, not the CLI's: an unrecognised value collapses into it
 * rather than failing the parse. A future build adding a seventh source must
 * not stop a terminal from being observed, and every source leads to the same
 * transition anyway. The raw payload is the ingest log's business.
 */
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | 'other';

/** From the payload field `reason` -- NOT `source`, which reads back undefined. */
export type SessionEndReason =
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
 * that edge was dead, and `PermissionRequest` is the only reliable producer.
 */
export type NotificationType =
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
 * Fields every hook payload carries.
 *
 * `sessionId` is the only one that is required. It is what the registry
 * compares against the entry's own id to notice that `/clear` started a new
 * conversation -- the comparison is with `entry.sessionId`, never with the
 * terminal id in the URL, which would differ always rather than on drift.
 */
export interface HookEventContext {
  readonly sessionId: SessionId;
  readonly promptId: string | null;
  readonly cwd: string | null;
  /** Where the conversation is recorded. The restore predicate needs it: a session that never received a prompt has no transcript at all. */
  readonly transcriptPath: string | null;
}

export interface SessionStartEvent extends HookEventContext {
  readonly kind: 'SessionStart';
  readonly source: SessionStartSource;
}

export interface SessionEndEvent extends HookEventContext {
  readonly kind: 'SessionEnd';
  readonly reason: SessionEndReason;
}

export interface UserPromptSubmitEvent extends HookEventContext {
  readonly kind: 'UserPromptSubmit';
  readonly userInput: string | null;
}

export interface PreToolUseEvent extends HookEventContext {
  readonly kind: 'PreToolUse';
  readonly toolName: string | null;
  readonly toolUseId: string | null;
}

export interface PostToolUseEvent extends HookEventContext {
  readonly kind: 'PostToolUse';
  readonly toolName: string | null;
  readonly toolUseId: string | null;
}

export interface PostToolUseFailureEvent extends HookEventContext {
  readonly kind: 'PostToolUseFailure';
  readonly toolName: string | null;
  readonly toolUseId: string | null;
  readonly errorMessage: string | null;
}

/** The only reliable producer of `waiting_permission`. */
export interface PermissionRequestEvent extends HookEventContext {
  readonly kind: 'PermissionRequest';
  readonly toolName: string | null;
  readonly permissionLevel: string | null;
}

export interface NotificationEvent extends HookEventContext {
  readonly kind: 'Notification';
  readonly notificationType: NotificationType;
  readonly message: string | null;
}

export interface StopEvent extends HookEventContext {
  readonly kind: 'Stop';
  /** From `last_assistant_message`, which the CLI provides precisely so that nobody parses a transcript. */
  readonly lastAssistantMessage: string | null;
}

export interface StopFailureEvent extends HookEventContext {
  readonly kind: 'StopFailure';
  readonly errorType: string | null;
  readonly errorMessage: string | null;
}

export interface CwdChangedEvent extends HookEventContext {
  readonly kind: 'CwdChanged';
  /** Field names measured on 2.1.225: `old_cwd` / `new_cwd`. `previous_cwd` occurs zero times in the binary. */
  readonly oldCwd: string | null;
  readonly newCwd: string | null;
}

/** Restoring took too long, and we no longer know what the process is doing. */
export interface ResumeTimedOutEvent {
  readonly kind: 'ResumeTimedOut';
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

export interface ResumeExitedNonZeroEvent {
  readonly kind: 'ResumeExitedNonZero';
  readonly exitCode: number;
}

const HOOK_EVENT_KINDS: ReadonlySet<string> = new Set<HookEvent['kind']>([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'CwdChanged',
]);

/** True for events that carry a session id -- the ones the registry checks for drift. */
export function isHookEvent(event: TerminalEvent): event is HookEvent {
  return HOOK_EVENT_KINDS.has(event.kind);
}

export function resumeTimedOut(): ResumeTimedOutEvent {
  return Object.freeze({ kind: 'ResumeTimedOut' });
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
 * A new terminal's `claude` exited with a non-zero code.
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

/** As `launchExitedNonZero`, for a restore. */
export function resumeExitedNonZero(exitCode: number): ResumeExitedNonZeroEvent {
  return Object.freeze({ kind: 'ResumeExitedNonZero', exitCode: assertNonZeroExit(exitCode) });
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
