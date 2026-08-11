import {
  HookEventParser,
  SessionId,
  type HookEvent,
  type HookEventParseResult,
} from '../../../packages/core/src/index';
import { SESSION_UUID } from '../../helpers/domain-fixtures';

const parser = new HookEventParser();

/** The minimum every hook payload carries. */
function payload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: SESSION_UUID, hook_event_name: 'Stop', ...extra };
}

function parseOrFail(body: unknown): HookEvent {
  const result: HookEventParseResult = parser.parse(body);
  if (result.status !== 'parsed') {
    throw new Error(`expected a parsed event, got ${result.status}`);
  }
  return result.event;
}

/**
 * Exactly the events subscribed in the `--settings` block of
 * 04-architecture.md. The table is the test: a member of the union with no case
 * in the parser shows up as a failing row rather than as silence.
 */
const SUBSCRIBED: readonly (readonly [string, HookEvent['kind']])[] = [
  ['SessionStart', 'SessionStart'],
  ['SessionEnd', 'SessionEnd'],
  ['UserPromptSubmit', 'UserPromptSubmit'],
  ['PreToolUse', 'PreToolUse'],
  ['PostToolUse', 'PostToolUse'],
  ['PostToolUseFailure', 'PostToolUseFailure'],
  ['PermissionRequest', 'PermissionRequest'],
  ['Notification', 'Notification'],
  ['Stop', 'Stop'],
  ['StopFailure', 'StopFailure'],
  ['CwdChanged', 'CwdChanged'],
];

describe('every subscribed hook event', () => {
  it.each(SUBSCRIBED)('parses %s', (hookEventName, kind) => {
    const event = parseOrFail(payload({ hook_event_name: hookEventName }));

    expect(event.kind).toBe(kind);
    expect(event.sessionId.value).toBe(SESSION_UUID);
  });

  it('covers all eleven, and nothing is listed twice', () => {
    expect(SUBSCRIBED).toHaveLength(11);
    expect(new Set(SUBSCRIBED.map(([name]) => name)).size).toBe(11);
  });

  it('carries the fields common to every payload', () => {
    const event = parseOrFail(
      payload({
        prompt_id: 'prompt-1',
        cwd: 'D:/Projects/foo',
        transcript_path: 'C:/Users/x/.claude/projects/foo/session.jsonl',
      })
    );

    expect(event.promptId).toBe('prompt-1');
    expect(event.cwd).toBe('D:/Projects/foo');
    // The restore predicate needs this: a session with no prompt has no
    // transcript, and --resume on it exits 1.
    expect(event.transcriptPath).toBe('C:/Users/x/.claude/projects/foo/session.jsonl');
  });
});

describe('SessionStart', () => {
  it.each(['startup', 'resume', 'clear', 'compact', 'fork'])('reads source %s', (source) => {
    const event = parseOrFail(payload({ hook_event_name: 'SessionStart', source }));

    expect(event.kind === 'SessionStart' ? event.source : null).toBe(source);
  });

  it('collapses an unknown or missing source into "other" instead of failing', () => {
    const unknown = parseOrFail(payload({ hook_event_name: 'SessionStart', source: 'teleport' }));
    const missing = parseOrFail(payload({ hook_event_name: 'SessionStart' }));

    expect(unknown.kind === 'SessionStart' ? unknown.source : null).toBe('other');
    expect(missing.kind === 'SessionStart' ? missing.source : null).toBe('other');
  });
});

describe('SessionEnd', () => {
  it('reads the reason from `reason`, which is the field that exists', () => {
    const event = parseOrFail(payload({ hook_event_name: 'SessionEnd', reason: 'logout' }));

    expect(event.kind === 'SessionEnd' ? event.reason : null).toBe('logout');
  });

  it('does not read it from `source`, which is the mistake this replaced', () => {
    // Parsing `source` here yielded undefined in silence for a whole design
    // round. A payload carrying only `source` must therefore fall back, not
    // succeed by accident.
    const event = parseOrFail(
      payload({ hook_event_name: 'SessionEnd', source: 'logout', reason: undefined })
    );

    expect(event.kind === 'SessionEnd' ? event.reason : null).toBe('other');
  });
});

describe('the tool events', () => {
  it('carries the tool name and use id', () => {
    const event = parseOrFail(
      payload({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1' })
    );

    expect(event.kind === 'PreToolUse' ? event.toolName : null).toBe('Bash');
    expect(event.kind === 'PreToolUse' ? event.toolUseId : null).toBe('toolu_1');
  });

  it('still parses without a tool name: the transition matters more than the label', () => {
    const event = parseOrFail(payload({ hook_event_name: 'PreToolUse' }));

    expect(event.kind).toBe('PreToolUse');
    expect(event.kind === 'PreToolUse' ? event.toolName : 'unset').toBeNull();
  });

  it('reads a whitespace-only identifier as absent, not as a name made of spaces', () => {
    const event = parseOrFail(
      payload({ hook_event_name: 'PreToolUse', tool_name: '   ', tool_use_id: '\t\n' })
    );

    expect(event.kind === 'PreToolUse' ? event.toolName : 'unset').toBeNull();
    expect(event.kind === 'PreToolUse' ? event.toolUseId : 'unset').toBeNull();
  });

  it('reads the failure message of PostToolUseFailure', () => {
    const event = parseOrFail(
      payload({ hook_event_name: 'PostToolUseFailure', error_message: 'exit 1' })
    );

    expect(event.kind === 'PostToolUseFailure' ? event.errorMessage : null).toBe('exit 1');
  });
});

describe('PermissionRequest', () => {
  it('is the only reliable producer of waiting_permission, and carries the tool', () => {
    const event = parseOrFail(
      payload({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Write',
        permission_level: 'ask',
      })
    );

    expect(event.kind === 'PermissionRequest' ? event.toolName : null).toBe('Write');
    expect(event.kind === 'PermissionRequest' ? event.permissionLevel : null).toBe('ask');
  });
});

describe('Notification', () => {
  it.each([
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
  ])('reads the measured literal %s', (notificationType) => {
    const event = parseOrFail(
      payload({ hook_event_name: 'Notification', notification_type: notificationType })
    );

    expect(event.kind === 'Notification' ? event.notificationType : null).toBe(notificationType);
  });

  it('treats a bare permission_prompt as unknown, because the CLI never sends it', () => {
    // The string exists in the binary's pool but never as a notification type.
    // An edge waiting for permission on this value was dead code.
    const event = parseOrFail(
      payload({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })
    );

    expect(event.kind === 'Notification' ? event.notificationType : null).toBe('other');
  });

  it('keeps the message', () => {
    const event = parseOrFail(
      payload({ hook_event_name: 'Notification', message: 'Claude needs your input' })
    );

    expect(event.kind === 'Notification' ? event.message : null).toBe('Claude needs your input');
  });
});

describe('Stop and StopFailure', () => {
  it('takes the assistant text from last_assistant_message', () => {
    const event = parseOrFail(
      payload({ hook_event_name: 'Stop', last_assistant_message: '  done.  ' })
    );

    // Verbatim: this is content, and trimming it would make the store disagree
    // with what was actually said.
    expect(event.kind === 'Stop' ? event.lastAssistantMessage : null).toBe('  done.  ');
  });

  it('separates the failure type from its message', () => {
    const event = parseOrFail(
      payload({
        hook_event_name: 'StopFailure',
        error_type: 'rate_limit',
        error_message: 'slow down',
      })
    );

    expect(event.kind === 'StopFailure' ? event.errorType : null).toBe('rate_limit');
    expect(event.kind === 'StopFailure' ? event.errorMessage : null).toBe('slow down');
  });
});

describe('CwdChanged', () => {
  it('reads old_cwd and new_cwd, the names that exist in the binary', () => {
    const event = parseOrFail(
      payload({ hook_event_name: 'CwdChanged', old_cwd: 'D:/a', new_cwd: 'D:/b' })
    );

    expect(event.kind === 'CwdChanged' ? event.oldCwd : null).toBe('D:/a');
    expect(event.kind === 'CwdChanged' ? event.newCwd : null).toBe('D:/b');
  });

  it('ignores previous_cwd, of which there are zero occurrences in the binary', () => {
    const event = parseOrFail(
      payload({ hook_event_name: 'CwdChanged', previous_cwd: 'D:/a', new_cwd: 'D:/b' })
    );

    expect(event.kind === 'CwdChanged' ? event.oldCwd : 'unset').toBeNull();
  });
});

describe('UserPromptSubmit', () => {
  it('keeps the prompt exactly as typed', () => {
    const event = parseOrFail(
      payload({ hook_event_name: 'UserPromptSubmit', user_input: '  indented on purpose' })
    );

    expect(event.kind === 'UserPromptSubmit' ? event.userInput : null).toBe(
      '  indented on purpose'
    );
  });
});

describe('an event we do not model', () => {
  it.each(['PreCompact', 'FileChanged', 'TaskCreated', 'SubagentStop', 'Setup'])(
    'is ignored rather than fatal: %s',
    (hookEventName) => {
      const result = parser.parse(payload({ hook_event_name: hookEventName }));

      expect(result.status).toBe('ignored');
      expect(result.status === 'ignored' ? result.hookEventName : null).toBe(hookEventName);
    }
  );

  it('is reported as ignored, not as malformed -- the distinction drives the log level', () => {
    // Claude Code emits well over thirty event types; twenty of them are
    // ordinary traffic for a runner subscribed to eleven. Calling that
    // malformed would drown the case that actually deserves attention.
    expect(parser.parse(payload({ hook_event_name: 'WorktreeCreate' })).status).toBe('ignored');
    expect(parser.parse({ nothing: true }).status).toBe('malformed');
  });
});

describe('a payload that is not a hook payload', () => {
  it.each([
    ['null', null],
    ['a string', '{"hook_event_name":"Stop"}'],
    ['a number', 42],
    ['an array', [{ hook_event_name: 'Stop' }]],
  ])('is malformed rather than thrown: %s', (_label, body) => {
    const result = parser.parse(body);

    expect(result.status).toBe('malformed');
  });

  it('is malformed when the event name is missing', () => {
    expect(parser.parse({ session_id: SESSION_UUID }).status).toBe('malformed');
  });

  it.each([
    ['absent', undefined],
    ['not a UUID', 'session-1'],
    ['not a string', 12345],
  ])('is malformed when session_id is %s', (_label, sessionId) => {
    const result = parser.parse({ hook_event_name: 'Stop', session_id: sessionId });

    expect(result.status).toBe('malformed');
    expect(result.status === 'malformed' ? result.reason : '').toContain('session_id');
  });

  it('never throws, whatever it is handed', () => {
    const hostile: readonly unknown[] = [
      undefined,
      Number.NaN,
      Symbol('x'),
      () => undefined,
      { hook_event_name: { nested: true }, session_id: SESSION_UUID },
      { hook_event_name: 'Stop', session_id: { value: SESSION_UUID } },
      new Map(),
    ];

    for (const body of hostile) {
      expect(() => parser.parse(body)).not.toThrow();
    }
  });
});

describe('the line between a bad payload and a bug of ours', () => {
  it('turns a domain refusal into "malformed", and lets anything else through', () => {
    // A ValidationError from the id means the payload was bad -- an ordinary
    // outcome. Any other throw means our own code is broken, and disguising
    // that as "malformed" would hide the bug behind a plausible log line.
    const spy = jest.spyOn(SessionId, 'fromString').mockImplementation(() => {
      throw new RangeError('a bug, not a bad payload');
    });

    try {
      expect(() => parser.parse(payload())).toThrow(RangeError);
    } finally {
      spy.mockRestore();
    }

    expect(parser.parse(payload()).status).toBe('parsed');
  });
});

describe('the parsed event', () => {
  it('is frozen', () => {
    const event = parseOrFail(payload());

    expect(Object.isFrozen(event)).toBe(true);
    expect(() => {
      (event as unknown as { kind: string }).kind = 'SessionEnd';
    }).toThrow(TypeError);
  });

  it('normalises the session id the way SessionId does', () => {
    const event = parseOrFail(payload({ session_id: `  ${SESSION_UUID.toUpperCase()}  ` }));

    expect(event.sessionId.value).toBe(SESSION_UUID);
  });
});

describe('the parser as the reader port', () => {
  it('reads a body the receiver took off the socket', () => {
    const result = parser.read(JSON.stringify(payload()));

    expect(result.status).toBe('parsed');
  });

  it('calls a body that is not JSON malformed rather than throwing', () => {
    // `read` is called from the sink, after the response has already gone out.
    // A throw there is reported to nobody, so a bad body has to come back as a
    // value -- the same rule that governs `parse`.
    for (const raw of ['', 'this is not json', '{"unclosed":', '{,}']) {
      expect(parser.read(raw)).toStrictEqual({
        status: 'malformed',
        reason: 'the body is not JSON',
      });
    }
  });

  it('does not quote the body back in the reason', () => {
    // The journal already has it verbatim. A log line carrying a megabyte of
    // tool output is how a log stops being read at all.
    const huge = `${'x'.repeat(4096)} not json`;

    expect(parser.read(huge).status).toBe('malformed');
    expect(JSON.stringify(parser.read(huge))).not.toContain('xxxx');
  });

  it('reads valid JSON that is not a hook payload as malformed too', () => {
    expect(parser.read('null').status).toBe('malformed');
    expect(parser.read('[]').status).toBe('malformed');
    expect(parser.read('"a string"').status).toBe('malformed');
  });

  it('passes an event it does not model straight through as ignored', () => {
    expect(parser.read(JSON.stringify(payload({ hook_event_name: 'PreCompact' })))).toStrictEqual({
      status: 'ignored',
      hookEventName: 'PreCompact',
    });
  });
});
