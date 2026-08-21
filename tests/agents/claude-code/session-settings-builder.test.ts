import {
  HOOK_EVENT_PATH_PREFIX,
  ListeningAddress,
  SessionSettingsBuilder,
  TOKEN_ENV_VAR,
  TerminalId,
  ValidationError,
  hookEventUrl,
  parseHookEventPath,
  type HookConfig,
  type SessionSettingsDocument,
} from '../../../packages/core/src/index';
import { NEXT_SESSION_UUID, TERMINAL_UUID, captureError } from '../../helpers/domain-fixtures';

/**
 * The oracle for `settings.json`.
 *
 * Every expectation here is written from a measured fact about the CLI rather
 * than from the builder's source, because all four failure modes of this file
 * are SILENT: a hook the CLI drops, an environment variable it interpolates to
 * an empty string, a timeout it defaults to ten minutes, and a user's own hooks
 * fired twice. None of them raises anything -- Claude Code treats a failed hook
 * as non-blocking and carries on [measured, 03].
 */

const ADDRESS = ListeningAddress.loopback(51_337);
const TERMINAL = TerminalId.fromString(TERMINAL_UUID);
const INTERPRETER = 'C:/Program Files/nodejs/node.exe';
const SCRIPT = 'C:/Users/x/.vscode/extensions/gripterm/dist/forwarder.js';

/**
 * The eleven events, listed here independently of the union the builder is
 * typed against. A registration silently missing from the file is the defect
 * this catches, and it cannot be caught by asking the implementation which
 * events it registered.
 */
const EXPECTED_EVENTS = [
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
  'SubagentStart',
  'SubagentStop',
  'CwdChanged',
];

/**
 * Events that carry no `waiting_permission`, no turn boundary and no proof of
 * life would leave the tree lying; these three are the ones П1 is written on,
 * so they are named rather than left to the count above.
 */
const LOAD_BEARING_EVENTS = [
  'UserPromptSubmit',
  'PermissionRequest',
  'Stop',
  // The fourth since 2026-08-21: without it `Stop` is read as the end of the
  // work, and the customer watched a green tick for the eighty seconds their
  // subagents went on running.
  'SubagentStart',
];

function build(overrides: Partial<Parameters<SessionSettingsBuilder['build']>[0]> = {}): SessionSettingsDocument {
  return new SessionSettingsBuilder().build({
    terminalId: TERMINAL,
    address: ADDRESS,
    sessionStart: { interpreterPath: INTERPRETER, scriptPath: SCRIPT },
    ...overrides,
  });
}

function everyHook(document: SessionSettingsDocument): HookConfig[] {
  return Object.values(document.hooks).flatMap((registrations) =>
    registrations.flatMap((registration) => [...registration.hooks])
  );
}

/** Every `$VAR` and `${VAR}` reference the CLI would try to interpolate. */
function referencedEnvVars(value: string): string[] {
  const references = value.matchAll(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/gu);
  return [...references].map((match) => match[1] ?? match[2] ?? '');
}

describe('SessionSettingsBuilder', () => {
  it('registers every hook event the parser can read, and no other key', () => {
    const document = build();

    expect(Object.keys(document.hooks).sort((a, b) => a.localeCompare(b))).toStrictEqual(
      [...EXPECTED_EVENTS].sort((a, b) => a.localeCompare(b))
    );
    expect(LOAD_BEARING_EVENTS.every((event) => event in document.hooks)).toBe(true);
  });

  it('writes nothing but hooks -- the CLI merges the user levels itself', () => {
    // A1, measured 2026-08-10: one run produced 12 firings = 4 levels x 3
    // events, so `--settings` MERGES `hooks` with user, project and local. A
    // builder that copied the user's hooks in here would fire each of them
    // twice, and the second firing is the user's own script running again.
    expect(Object.keys(build())).toStrictEqual(['hooks']);
  });

  it('leaves every registration without a matcher, which is how the CLI spells "all"', () => {
    // `matcher: N().optional()`, "empty to match all" [binary 2.1.225]. A
    // matcher naming tool names would silence PreToolUse for every tool nobody
    // thought to list -- including the MCP ones, whose names we cannot know.
    const registrations = Object.values(build().hooks).flat();

    expect(registrations).toHaveLength(EXPECTED_EVENTS.length);
    expect(registrations.every((registration) => !('matcher' in registration))).toBe(true);
  });

  describe('transport', () => {
    it('carries SessionStart by command hook, because HTTP never arrives for it', () => {
      // Binary 2.1.225 filters unconditionally: `if (k.hook.type === "http")
      // return w("Skipping HTTP hook ... not supported for ..."), !1`. Registering
      // SessionStart over HTTP costs no error and no event -- the terminal simply
      // stays `launching` forever.
      const [registration] = build().hooks.SessionStart;
      const hook = registration?.hooks[0];

      expect(hook?.type).toBe('command');
    });

    it.each(EXPECTED_EVENTS.filter((event) => event !== 'SessionStart'))(
      'carries %s over HTTP',
      (event) => {
        const hooks = build().hooks[event as keyof SessionSettingsDocument['hooks']].flatMap(
          (registration) => [...registration.hooks]
        );

        expect(hooks).toHaveLength(1);
        expect(hooks[0]?.type).toBe('http');
      }
    );

    it('registers no SessionStart at all when there is nothing to run the forwarder with', () => {
      // No `node` on this machine's PATH means no interpreter for the command
      // hook (C5-2). The direction of the refusal is chosen and stated: one
      // event is lost, ten keep arriving. Refusing to launch instead would cost
      // the person a terminal over a channel that carries `/clear` renames and
      // the pid -- valuable, and not the whole of observation (§4.7).
      const document = build({ sessionStart: null });

      expect(document.hooks.SessionStart).toEqual([]);
      expect(document.hooks.Stop).toHaveLength(1);
    });

    it('gives the command hook an argument list, so no shell parses our paths', () => {
      // `args` present => "`command` is resolved as an executable and spawned
      // directly ... no shell" [binary 2.1.225]. Without it the command string
      // goes through PowerShell on Windows, where `C:\Program Files\...` is two
      // arguments. Nothing here may therefore be quoted BY US.
      const hook = build().hooks.SessionStart[0]?.hooks[0];

      expect(hook).toStrictEqual({
        type: 'command',
        command: INTERPRETER,
        args: [SCRIPT, hookEventUrl(ADDRESS, TERMINAL)],
        timeout: expect.any(Number) as number,
      });
      expect(JSON.stringify(hook)).not.toMatch(/\\"|'/u);
    });
  });

  describe('addressing', () => {
    it('points every HTTP hook at this activation, terminal and port', () => {
      const urls = new Set(
        everyHook(build())
          .filter((hook): hook is Extract<HookConfig, { type: 'http' }> => hook.type === 'http')
          .map((hook) => hook.url)
      );

      expect(urls).toStrictEqual(new Set([hookEventUrl(ADDRESS, TERMINAL)]));
      expect(new URL([...urls][0] ?? '').port).toBe('51337');
    });

    it('addresses the terminal by our id, and lets the reader get it back', () => {
      // The id in the URL is the ADDRESS of the record; the `session_id` in the
      // body is a different identifier that drifts on `/clear`. Comparing the
      // two would be a permanent mismatch, so the path is what routes.
      const url = new URL(hookEventUrl(ADDRESS, TERMINAL));

      expect(url.pathname.startsWith(HOOK_EVENT_PATH_PREFIX)).toBe(true);
      expect(parseHookEventPath(url.pathname)?.equals(TERMINAL)).toBe(true);
    });

    it.each<readonly [string, string | undefined]>([
      ['a path that is not ours', '/other/550e8400-e29b-41d4-a716-446655440000'],
      ['a path with no id at all', HOOK_EVENT_PATH_PREFIX],
      ['an id that is not a UUID', `${HOOK_EVENT_PATH_PREFIX}not-a-uuid`],
      ['a deeper path', `${HOOK_EVENT_PATH_PREFIX}${TERMINAL_UUID}/extra`],
      // Node types `IncomingMessage.url` as optional, so the receiver hands it
      // over as it comes. An absent path and an unrecognisable one deserve the
      // same 404, and answering both here keeps a `?? ''` out of the server
      // that no test could ever reach.
      ['no path at all', undefined],
    ])('reads back nothing from %s', (_why, pathname) => {
      expect(parseHookEventPath(pathname)).toBeNull();
    });

    it('is regenerated per activation rather than remembered', () => {
      // The port is ephemeral and the file outlives the process that wrote it.
      // A builder that cached anything would hand the next activation the dead
      // port of the previous one, and every hook would fail into the void.
      const moved = build({ address: ListeningAddress.loopback(51_338) });
      const other = build({ terminalId: TerminalId.fromString(NEXT_SESSION_UUID) });

      expect(JSON.stringify(moved)).not.toBe(JSON.stringify(build()));
      expect(JSON.stringify(other)).not.toBe(JSON.stringify(build()));
    });
  });

  describe('authorisation', () => {
    it('names the token but never carries it', () => {
      const http = everyHook(build()).filter(
        (hook): hook is Extract<HookConfig, { type: 'http' }> => hook.type === 'http'
      );

      expect(http.every((hook) => hook.headers.Authorization === `Bearer $${TOKEN_ENV_VAR}`)).toBe(
        true
      );
    });

    it('declares every variable it references, or the CLI silently sends an empty one', () => {
      // "Only variables listed here will be resolved; all other $VAR references
      // are left as empty strings" [binary 2.1.225]. An undeclared reference
      // produces `Authorization: Bearer ` -- a 401 on every event, with the file
      // looking correct to a reader.
      const undeclared = everyHook(build())
        .filter((hook): hook is Extract<HookConfig, { type: 'http' }> => hook.type === 'http')
        .flatMap((hook) =>
          Object.values(hook.headers)
            .flatMap(referencedEnvVars)
            .filter((name) => !hook.allowedEnvVars.includes(name))
        );

      expect(undeclared).toStrictEqual([]);
    });
  });

  it('gives every hook an explicit timeout inside the budget', () => {
    // The CLI default is 600000 ms [binary 2.1.224: `var Dh=600000; ... let s =
    // e.timeout ? e.timeout*1000 : o`], and the unit is SECONDS. A hung
    // Extension Host holds the socket, so an implicit timeout would stall the
    // conversation for ten minutes per event.
    const timeouts = everyHook(build()).map((hook) => hook.timeout);

    expect(timeouts).toHaveLength(EXPECTED_EVENTS.length);
    expect(timeouts.every((timeout) => Number.isInteger(timeout) && timeout >= 2 && timeout <= 5)).toBe(
      true
    );
  });

  describe('the forwarder it cannot check at runtime', () => {
    it.each([
      ['the interpreter', { interpreterPath: 'node', scriptPath: SCRIPT }],
      ['the script', { interpreterPath: INTERPRETER, scriptPath: 'dist/forwarder.js' }],
    ])('refuses a relative path for %s', (_which, sessionStart) => {
      // A hook runs with the terminal's PATH, not the editor's, and a bare
      // `node` there is not guaranteed [C5-2]. The failure is a hook that never
      // fires, which is indistinguishable from a terminal that never started.
      expect(captureError(() => build({ sessionStart }))).toBeInstanceOf(ValidationError);
    });

    it('accepts a POSIX absolute path as readily as a Windows one', () => {
      const document = build({
        sessionStart: { interpreterPath: '/usr/bin/node', scriptPath: '/opt/gripterm/forwarder.js' },
      });

      expect(document.hooks.SessionStart[0]?.hooks[0]).toMatchObject({ command: '/usr/bin/node' });
    });
  });
});
