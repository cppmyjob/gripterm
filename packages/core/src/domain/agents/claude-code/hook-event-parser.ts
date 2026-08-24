import { DOMAIN_EVENT_OF_HOOK } from './hook-vocabulary';
import { SessionId } from '../../entities/session-id';
import { isGriptermError } from '../../errors/gripterm-error';
import type {
  AgentEvent,
  AgentEventContext,
  AgentNoticeType,
  ConversationEndReason,
  ConversationStartSource,
} from '../../events/terminal-event';
import type { HookEventParseResult, HookEventReader } from '../../ports/hook-event-reader';

const SESSION_START_SOURCES: ReadonlySet<string> = new Set<ConversationStartSource>([
  'startup',
  'resume',
  'clear',
  'compact',
  'fork',
  'other',
]);

const SESSION_END_REASONS: ReadonlySet<string> = new Set<ConversationEndReason>([
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'bypass_permissions_disabled',
  'other',
]);

const NOTIFICATION_TYPES: ReadonlySet<string> = new Set<AgentNoticeType>([
  'agent_completed',
  'agent_needs_input',
  'auth_success',
  'computer_use_enter',
  'computer_use_exit',
  'elicitation_complete',
  'elicitation_response',
  'idle_prompt',
  'push_notification',
  'worker_permission_prompt',
  'other',
]);

/**
 * The translator: one Claude Code hook payload becomes one `AgentEvent`.
 *
 * This class IS the seam between the two vocabularies. It switches on the words
 * Claude Code sends (`hook_event_name`, an external format) and hands back the
 * words the domain speaks, taken from `DOMAIN_EVENT_OF_HOOK` so that the two
 * columns cannot drift apart in two files. Nothing downstream of here -- not
 * the state machine, not the projection, not the panel -- can tell whose CLI
 * this was.
 *
 * Two rules run through the whole class, and both exist because this parser
 * sits on an HTTP endpoint that anything on the loopback interface can reach,
 * and because a runner that throws is a runner that stops observing:
 *
 *   1. NOTHING throws. Every refusal comes back as a value.
 *   2. A missing DETAIL never costs the event. `PreToolUse` without a
 *      `tool_name` still means a turn is running, and that transition is worth
 *      more than the label. Only `session_id` is required, because it is the
 *      value the registry compares to notice that `/clear` began a new
 *      conversation -- and even then the terminal id in the URL still routes
 *      the request, so a malformed body degrades rather than blinds.
 */
export class HookEventParser implements HookEventReader {
  /**
   * The port method: a body, verbatim, as the receiver took it off the socket.
   *
   * That a hook body is JSON is a fact about THIS CLI's hook transport, so
   * `JSON.parse` belongs on this side of the seam and not in the registry --
   * which is also the only reason the registry can stay ignorant of which agent
   * it observes (§4.6, decision №34).
   */
  public read(raw: string): HookEventParseResult {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      // Deliberately does not quote the body back. It reaches the journal
      // verbatim already, and a log line carrying a megabyte of tool output is
      // how a log stops being read.
      return { status: 'malformed', reason: 'the body is not JSON' };
    }
    return this.parse(payload);
  }

  public parse(payload: unknown): HookEventParseResult {
    if (!isRecord(payload)) {
      return { status: 'malformed', reason: 'the payload is not a JSON object' };
    }

    const hookEventName = readToken(payload, 'hook_event_name');
    if (hookEventName === null) {
      return { status: 'malformed', reason: 'the payload carries no hook_event_name' };
    }

    const context = this._readContext(payload);
    if (context === null) {
      return {
        status: 'malformed',
        reason: 'the payload carries no usable session_id',
      };
    }

    switch (hookEventName) {
      case 'SessionStart':
        return parsed({
          ...context,
          kind: DOMAIN_EVENT_OF_HOOK.SessionStart,
          source: narrow(readToken(payload, 'source'), SESSION_START_SOURCES, 'other'),
        });

      case 'SessionEnd':
        // `reason`, not `source`. Reading `source` here returned undefined in
        // silence, which is how the mistake survived a whole design round.
        return parsed({
          ...context,
          kind: DOMAIN_EVENT_OF_HOOK.SessionEnd,
          reason: narrow(readToken(payload, 'reason'), SESSION_END_REASONS, 'other'),
        });

      case 'UserPromptSubmit':
        return parsed({
          ...context,
          kind: DOMAIN_EVENT_OF_HOOK.UserPromptSubmit,
          userInput: readString(payload, 'user_input'),
        });

      case 'PreToolUse':
        return parsed({
          ...context,
          kind: DOMAIN_EVENT_OF_HOOK.PreToolUse,
          toolName: readToken(payload, 'tool_name'),
          toolUseId: readToken(payload, 'tool_use_id'),
        });

      case 'PostToolUse':
        return parsed({
          ...context,
          kind: DOMAIN_EVENT_OF_HOOK.PostToolUse,
          toolName: readToken(payload, 'tool_name'),
          toolUseId: readToken(payload, 'tool_use_id'),
        });

      case 'PostToolUseFailure':
        return parsed({
          ...context,
          kind: DOMAIN_EVENT_OF_HOOK.PostToolUseFailure,
          toolName: readToken(payload, 'tool_name'),
          toolUseId: readToken(payload, 'tool_use_id'),
          errorMessage: readString(payload, 'error_message'),
        });

      case 'PermissionRequest':
        return parsed({
          ...context,
          kind: DOMAIN_EVENT_OF_HOOK.PermissionRequest,
          toolName: readToken(payload, 'tool_name'),
          permissionLevel: readToken(payload, 'permission_level'),
        });

      case 'Notification':
        return parsed({
          ...context,
          kind: DOMAIN_EVENT_OF_HOOK.Notification,
          notificationType: narrow(
            readToken(payload, 'notification_type'),
            NOTIFICATION_TYPES,
            'other'
          ),
          message: readString(payload, 'message'),
        });

      case 'Stop':
        return parsed({
          ...context,
          kind: DOMAIN_EVENT_OF_HOOK.Stop,
          lastAssistantMessage: readString(payload, 'last_assistant_message'),
        });

      case 'SubagentStart':
        return parsed({
          ...context,
          kind: DOMAIN_EVENT_OF_HOOK.SubagentStart,
          agentId: readToken(payload, 'agent_id'),
          agentType: readToken(payload, 'agent_type'),
        });

      case 'SubagentStop':
        return parsed({
          ...context,
          kind: DOMAIN_EVENT_OF_HOOK.SubagentStop,
          agentId: readToken(payload, 'agent_id'),
          agentType: readToken(payload, 'agent_type'),
        });

      case 'StopFailure':
        return parsed({
          ...context,
          kind: DOMAIN_EVENT_OF_HOOK.StopFailure,
          errorType: readToken(payload, 'error_type'),
          errorMessage: readString(payload, 'error_message'),
        });

      case 'CwdChanged':
        return parsed({
          ...context,
          kind: DOMAIN_EVENT_OF_HOOK.CwdChanged,
          oldCwd: readString(payload, 'old_cwd'),
          newCwd: readString(payload, 'new_cwd'),
        });

      default:
        return { status: 'ignored', hookEventName };
    }
  }

  private _readContext(payload: Record<string, unknown>): AgentEventContext | null {
    const rawSessionId = readToken(payload, 'session_id');
    if (rawSessionId === null) {
      return null;
    }

    try {
      return {
        sessionId: SessionId.fromString(rawSessionId),
        promptId: readToken(payload, 'prompt_id'),
        cwd: readString(payload, 'cwd'),
        transcriptPath: readString(payload, 'transcript_path'),
      };
    } catch (error: unknown) {
      // The one place a throw is possible, and it is converted rather than
      // propagated: an unreadable id must not take the endpoint down.
      if (isGriptermError(error)) {
        return null;
      }
      throw error;
    }
  }
}

function parsed(event: AgentEvent): HookEventParseResult {
  return { status: 'parsed', event: Object.freeze(event) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads content verbatim: anything that is not a string -- absent, null, a
 * number -- reads as absent, and an empty string reads as absent too, but what
 * is there is returned untouched.
 *
 * Deliberately does not trim. A prompt and an assistant message are content,
 * and quietly reshaping content is how a store starts disagreeing with what the
 * person actually typed.
 */
function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return value;
}

/** As `readString`, for values that are identifiers rather than content: surrounding space is noise there. */
function readToken(source: Record<string, unknown>, key: string): string | null {
  const value = readString(source, key);
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function narrow<TValue extends string>(
  raw: string | null,
  allowed: ReadonlySet<string>,
  fallback: TValue
): TValue {
  return raw !== null && allowed.has(raw) ? (raw as TValue) : fallback;
}
