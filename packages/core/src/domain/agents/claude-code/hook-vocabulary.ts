import type { AgentEvent } from '../../events/terminal-event';

/**
 * Layer one of two: Claude Code's own words, and what each of them means to us.
 *
 * The domain has an alphabet of its own -- `ToolStarted`, `TurnFinished`,
 * `PermissionRequested` -- and those are sentences about ANY agent. The words
 * below are not ours at all: they are the values Claude Code puts in
 * `hook_event_name`, an external format we do not get to name, arriving over
 * HTTP from a CLI that adds to them between builds. This table is the whole of
 * the translation between the two, and it is the only place in the build where
 * both vocabularies are written down together.
 *
 * **It is also the compatibility guarantee for what is already on disk.** The
 * journal stores hook BODIES -- `raw`, or the structural fields redaction kept,
 * both carrying `hook_event_name` -- and never our reading of them
 * (`journal-line.ts`). So a record written by an earlier build replays through
 * this table exactly as a live event does, and renaming a domain event costs
 * nothing on disk as long as the left-hand column below keeps saying what the
 * CLI says. Renaming a left-hand entry is the change that would cost history:
 * that column is somebody else's format.
 *
 * A hook name absent from this table is not an error. `HookEventParser` reports
 * it as `ignored`, which is the right answer for the twenty-odd hooks the CLI
 * emits that say nothing about the state of a terminal.
 */
export const DOMAIN_EVENT_OF_HOOK = {
  SessionStart: 'ConversationStarted',
  SessionEnd: 'ConversationEnded',
  UserPromptSubmit: 'PromptSubmitted',
  PreToolUse: 'ToolStarted',
  PostToolUse: 'ToolFinished',
  PostToolUseFailure: 'ToolFailed',
  PermissionRequest: 'PermissionRequested',
  Notification: 'AgentNotified',
  Stop: 'TurnFinished',
  StopFailure: 'TurnFailed',
  SubagentStart: 'SubagentStarted',
  SubagentStop: 'SubagentFinished',
  CwdChanged: 'WorkingDirectoryChanged',
} as const satisfies Readonly<Record<string, AgentEvent['kind']>>;

/** The hook names this build understands. Claude Code emits more; those are ignored, not refused. */
export type ClaudeCodeHookName = keyof typeof DOMAIN_EVENT_OF_HOOK;

export const CLAUDE_CODE_HOOK_NAMES: readonly ClaudeCodeHookName[] = Object.freeze(
  Object.keys(DOMAIN_EVENT_OF_HOOK) as ClaudeCodeHookName[]
);
