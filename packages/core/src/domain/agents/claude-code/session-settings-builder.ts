import { posix, win32 } from 'node:path';
import { ValidationError } from '../../errors/gripterm-error';
import { hookEventUrl } from '../../services/hook-endpoint';
import type { ListeningAddress } from '../../entities/listening-address';
import type { TerminalId } from '../../entities/terminal-id';
import type { HookEvent } from '../../events/terminal-event';

/**
 * The name -- never the value -- of the per-activation token. It reaches the
 * CLI through the terminal's environment; this file only ever says which
 * variable to read, so a settings file left on disk after a crash discloses
 * nothing.
 */
export const TOKEN_ENV_VAR = 'GRIPTERM_TOKEN';

/**
 * Seconds, not milliseconds [binary 2.1.224: `let s = e.timeout ? e.timeout*1000
 * : o`, `var Dh=600000`]. Both values are inside the 2-5 s budget of §4.7 and
 * both are stated explicitly, because the default is TEN MINUTES: a hung
 * Extension Host holds the socket open, and the conversation would wait.
 *
 * They differ because the work differs. The HTTP receiver answers before it
 * processes anything, so two seconds is already several thousand loopback
 * round-trips. The command forwarder has to start an interpreter first, and a
 * cold process start on Windows is not measured in milliseconds.
 */
const HTTP_HOOK_TIMEOUT_SECONDS = 2;
const COMMAND_HOOK_TIMEOUT_SECONDS = 5;

export interface HttpHookConfig {
  readonly type: 'http';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * "Required for env var interpolation to work ... all other $VAR references
   * are left as empty strings" [binary 2.1.225]. Omit it and every request
   * carries `Authorization: Bearer ` -- a 401 per event, on a file that reads
   * correctly.
   */
  readonly allowedEnvVars: readonly string[];
  readonly timeout: number;
}

export interface CommandHookConfig {
  readonly type: 'command';
  readonly command: string;
  /**
   * The exec form. "When present, `command` is resolved as an executable and
   * spawned directly with these arguments -- no shell ... When absent,
   * `command` runs through a shell (bash on POSIX, PowerShell on Windows
   * without Git Bash)" [binary 2.1.225].
   *
   * This is the same win §4.4 took on the launch path: no shell means no
   * quoting, and no quoting means `C:\Program Files\...` stops being two
   * arguments. Nothing assembled here may be quoted by us.
   */
  readonly args: readonly string[];
  readonly timeout: number;
}

export type HookConfig = HttpHookConfig | CommandHookConfig;

/** A matcher group. Ours never carry a `matcher`: absent means every occurrence. */
export interface HookRegistration {
  readonly hooks: readonly HookConfig[];
}

/**
 * Exactly the events the parser can read (M1.3), as a `Record` rather than a
 * partial map: a member added to the union and forgotten here is a compile
 * error, not a hook that quietly never fires.
 */
export type HookEventName = HookEvent['kind'];

/**
 * What is written to `--settings`.
 *
 * `hooks` is the only key, and its absence of company is the point. A1
 * (measured 2026-08-10) established that the CLI merges `hooks` across user,
 * project and local levels with ours rather than replacing them, so copying
 * the user's hooks in here would fire each of them twice.
 */
export interface SessionSettingsDocument {
  readonly hooks: Readonly<Record<HookEventName, readonly HookRegistration[]>>;
}

/** An interpreter and the script it runs, both by absolute path. */
export interface ForwarderScript {
  readonly interpreterPath: string;
  readonly scriptPath: string;
}

export interface SessionSettingsParams {
  readonly terminalId: TerminalId;
  readonly address: ListeningAddress;
  readonly sessionStart: ForwarderScript;
}

/**
 * Builds the settings file for one terminal, for one activation.
 *
 * Pure by construction, and that is what makes the lifecycle rule of §4.4
 * enforceable: the file is a derived artefact regenerated before every launch
 * and every restore, because the port inside it belongs to the activation that
 * wrote it. Anything cached here would hand the next activation a dead port,
 * and a dead port is silent -- a failed hook is non-blocking, so the CLI would
 * carry on and the terminal would simply never be seen again.
 */
export class SessionSettingsBuilder {
  public build(params: SessionSettingsParams): SessionSettingsDocument {
    const url = hookEventUrl(params.address, params.terminalId);

    return {
      hooks: {
        // The only event that cannot travel over HTTP: build 2.1.225 filters it
        // unconditionally (`Skipping HTTP hook ... not supported for ...`), so
        // an HTTP registration here would cost no error and no event either.
        SessionStart: [{ hooks: [forwarderHook(params.sessionStart, url)] }],
        SessionEnd: httpRegistration(url),
        UserPromptSubmit: httpRegistration(url),
        PreToolUse: httpRegistration(url),
        PostToolUse: httpRegistration(url),
        PostToolUseFailure: httpRegistration(url),
        PermissionRequest: httpRegistration(url),
        Notification: httpRegistration(url),
        Stop: httpRegistration(url),
        StopFailure: httpRegistration(url),
        CwdChanged: httpRegistration(url),
      },
    };
  }
}

function httpRegistration(url: string): readonly HookRegistration[] {
  return [
    {
      hooks: [
        {
          type: 'http',
          url,
          headers: { Authorization: `Bearer $${TOKEN_ENV_VAR}` },
          allowedEnvVars: [TOKEN_ENV_VAR],
          timeout: HTTP_HOOK_TIMEOUT_SECONDS,
        },
      ],
    },
  ];
}

function forwarderHook(script: ForwarderScript, url: string): CommandHookConfig {
  return {
    type: 'command',
    command: requireAbsolute(script.interpreterPath, 'interpreterPath'),
    args: [requireAbsolute(script.scriptPath, 'scriptPath'), url],
    timeout: COMMAND_HOOK_TIMEOUT_SECONDS,
  };
}

/**
 * A hook runs with the TERMINAL's environment, not the editor's, and a bare
 * `node` on that PATH is not guaranteed (C5-2). Both spellings of absolute are
 * accepted rather than the host platform's own: this builder writes a file, and
 * which machine reads it is not its business.
 */
function requireAbsolute(value: string, field: string): string {
  if (!win32.isAbsolute(value) && !posix.isAbsolute(value)) {
    throw new ValidationError(`${field} must be an absolute path`, {
      details: { field, value },
    });
  }
  return value;
}
