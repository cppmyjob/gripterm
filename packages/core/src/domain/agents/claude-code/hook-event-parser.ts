import { SessionId } from '../../entities/session-id';
import { isGriptermError } from '../../errors/gripterm-error';
import type {
  HookEvent,
  HookEventContext,
  NotificationType,
  SessionEndReason,
  SessionStartSource,
} from '../../events/terminal-event';

/**
 * The outcome of reading one HTTP body.
 *
 * Three outcomes rather than two, because "an event we do not model" and "this
 * is not a hook payload" call for opposite reactions. Claude Code emits well
 * over thirty event types and adds more between builds; subscribing to eleven
 * of them means the other twenty are ordinary, expected traffic. A payload that
 * is not a hook payload at all is a symptom -- of a wrong port, a proxy, a
 * changed contract -- and deserves a loud log.
 */
export type HookEventParseResult =
  | { readonly status: 'parsed', readonly event: HookEvent }
  | { readonly status: 'ignored', readonly hookEventName: string }
  | { readonly status: 'malformed', readonly reason: string };

const SESSION_START_SOURCES: ReadonlySet<string> = new Set<SessionStartSource>([
  'startup',
  'resume',
  'clear',
  'compact',
  'fork',
  'other',
]);

const SESSION_END_REASONS: ReadonlySet<string> = new Set<SessionEndReason>([
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'bypass_permissions_disabled',
  'other',
]);

const NOTIFICATION_TYPES: ReadonlySet<string> = new Set<NotificationType>([
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
 * Turns a hook payload into a `HookEvent`.
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
export class HookEventParser {
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
          kind: 'SessionStart',
          source: narrow(readToken(payload, 'source'), SESSION_START_SOURCES, 'other'),
        });

      case 'SessionEnd':
        // `reason`, not `source`. Reading `source` here returned undefined in
        // silence, which is how the mistake survived a whole design round.
        return parsed({
          ...context,
          kind: 'SessionEnd',
          reason: narrow(readToken(payload, 'reason'), SESSION_END_REASONS, 'other'),
        });

      case 'UserPromptSubmit':
        return parsed({
          ...context,
          kind: 'UserPromptSubmit',
          userInput: readString(payload, 'user_input'),
        });

      case 'PreToolUse':
        return parsed({
          ...context,
          kind: 'PreToolUse',
          toolName: readToken(payload, 'tool_name'),
          toolUseId: readToken(payload, 'tool_use_id'),
        });

      case 'PostToolUse':
        return parsed({
          ...context,
          kind: 'PostToolUse',
          toolName: readToken(payload, 'tool_name'),
          toolUseId: readToken(payload, 'tool_use_id'),
        });

      case 'PostToolUseFailure':
        return parsed({
          ...context,
          kind: 'PostToolUseFailure',
          toolName: readToken(payload, 'tool_name'),
          toolUseId: readToken(payload, 'tool_use_id'),
          errorMessage: readString(payload, 'error_message'),
        });

      case 'PermissionRequest':
        return parsed({
          ...context,
          kind: 'PermissionRequest',
          toolName: readToken(payload, 'tool_name'),
          permissionLevel: readToken(payload, 'permission_level'),
        });

      case 'Notification':
        return parsed({
          ...context,
          kind: 'Notification',
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
          kind: 'Stop',
          lastAssistantMessage: readString(payload, 'last_assistant_message'),
        });

      case 'StopFailure':
        return parsed({
          ...context,
          kind: 'StopFailure',
          errorType: readToken(payload, 'error_type'),
          errorMessage: readString(payload, 'error_message'),
        });

      case 'CwdChanged':
        return parsed({
          ...context,
          kind: 'CwdChanged',
          oldCwd: readString(payload, 'old_cwd'),
          newCwd: readString(payload, 'new_cwd'),
        });

      default:
        return { status: 'ignored', hookEventName };
    }
  }

  private _readContext(payload: Record<string, unknown>): HookEventContext | null {
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

function parsed(event: HookEvent): HookEventParseResult {
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
