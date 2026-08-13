import { requireAbsolutePath } from '../../entities/absolute-path';
import { ValidationError } from '../../errors/gripterm-error';
import { TOKEN_ENV_VAR } from './session-settings-builder';
import type { AgentCommand } from '../../entities/agent-command';
import type { LaunchIntent } from '../../entities/launch-intent';
import type { LaunchRecipe } from '../../entities/launch-recipe';
import type { TerminalEntry } from '../../entities/terminal-entry';

export interface LaunchCommandParams {
  /** Absolute path to `claude`, resolved once at activation (M1.14). */
  readonly executablePath: string;
  readonly entry: TerminalEntry;
  readonly intent: LaunchIntent;
  /** Absolute path to the file `SessionSettingsBuilder` wrote for THIS activation. */
  readonly settingsPath: string;
  /** The value behind `GRIPTERM_TOKEN`, which the hooks send back as a bearer. */
  readonly token: string;
}

/**
 * Everything this project knows about how to start Claude Code, and the only
 * place that knows it.
 *
 * It takes a `settingsPath: string` rather than a general `{ args, env }`
 * describing "install observation". Generalising here would be design by
 * documentation: the shape of a second agent's settings is something we have
 * read about and not measured (A17), and a port shaped from a guess is the kind
 * of work that gets redone. The boundary that matters -- this directory -- is
 * already drawn and enforced by the linter.
 */
export class LaunchCommandBuilder {
  public build(params: LaunchCommandParams): AgentCommand {
    const executable = requireAbsolutePath(params.executablePath, 'executablePath');
    const settingsPath = requireAbsolutePath(params.settingsPath, 'settingsPath');
    if (params.token.trim().length === 0) {
      throw new ValidationError('token must not be blank');
    }

    const { launch } = params.entry;
    const args = [
      // --- variadic first, always ---------------------------------------------
      // `--add-dir <directories...>` and `--mcp-config <configs...>` swallow
      // every token up to the next flag [measured, A2]. Emitting them first, and
      // `--settings` last, is what keeps a positional prompt reachable for the
      // programmatic callers of M4. The failure they would otherwise produce is
      // not an error but a session that quietly started with no prompt.
      ...variadic('--add-dir', launch.addDirs),
      ...variadic('--mcp-config', launch.mcpConfigPaths),

      // --- identity: the two paths are disjoint, see `LaunchIntent` -----------
      ...(params.intent === 'launch'
        ? ['--session-id', params.entry.sessionId.value]
        : ['--resume', params.entry.sessionId.value]),

      ...scalars(launch, params.intent),

      // --- last, and deliberately so ------------------------------------------
      // A path rather than inline JSON: the file can be opened when something
      // breaks, and no shell ever has to survive a JSON string full of braces
      // and quotes (§4.4). Its position is the invariant above.
      '--settings',
      settingsPath,
    ];

    return Object.freeze({
      executable,
      args: Object.freeze(args),
      // Ours last: a recipe that shadowed the token would authenticate as an
      // empty string, every hook would come back 401, and the terminal would run
      // perfectly while being invisible. The removals come FIRST, so a recipe
      // that names one of them on purpose still wins.
      env: Object.freeze({
        ...INHERITED_FROM_ANOTHER_RUN,
        ...launch.extraEnv,
        [TOKEN_ENV_VAR]: params.token,
      }),
    });
  }
}

/**
 * The variables a running Claude Code session exports to whatever it starts,
 * every one of them removed from the terminals we open.
 *
 * WHY, measured (A28, 2026-08-13). A person who types `code .` inside a Claude
 * Code terminal gives their editor that session's environment, and every
 * terminal the editor opens inherits it. With `CLAUDE_CODE_CHILD_SESSION`
 * present the CLI writes **no transcript and no history line at all** -- so the
 * conversation cannot be resumed by us, by `claude --resume`, or by anything
 * else, and nothing says so. Isolated by measurement: with that one variable
 * kept and the rest removed, nothing is written; with it removed and the rest
 * kept, the transcript appears the moment the turn ends.
 *
 * The others are on the list for the same reason rather than by measurement:
 * each of them NAMES ANOTHER RUN -- its pid, its session id, its IDE channel,
 * its binary, its env file, its project -- and a terminal of ours is not that
 * run's child. The CLI sets the ones it wants for its own children itself.
 *
 * What is deliberately NOT here: `CLAUDE_CONFIG_DIR`, which chooses the profile
 * a person is logged into, `CLAUDE_EFFORT`, and everything `ANTHROPIC_*`. Those
 * are configuration somebody may have set on purpose, and this rule is about the
 * identity of a run, not about every name that starts with the same word.
 */
const INHERITED_FROM_ANOTHER_RUN: Readonly<Record<string, null>> = Object.freeze({
  CLAUDE_CODE_CHILD_SESSION: null,
  CLAUDECODE: null,
  CLAUDE_CODE_ENTRYPOINT: null,
  CLAUDE_CODE_SESSION_ID: null,
  CLAUDE_CODE_SSE_PORT: null,
  CLAUDE_CODE_EXECPATH: null,
  CLAUDE_PID: null,
  CLAUDE_ENV_FILE: null,
  CLAUDE_PROJECT_DIR: null,
});

function variadic(flag: string, values: readonly string[]): string[] {
  return values.length === 0 ? [] : [flag, ...values];
}

function scalars(launch: LaunchRecipe, intent: LaunchIntent): string[] {
  const args: string[] = [];
  push(args, '--permission-mode', launch.permissionMode);
  push(args, '--model', launch.model);
  push(args, '--agent', launch.agent);
  // `--worktree [name]` CREATES a worktree and a branch for the session. On a
  // restore the worktree is already there and the session belongs to it by cwd,
  // so asking again would branch a second time. M2.11 owns the other half of
  // this: the recipe stores a worktree NAME, and a restore needs the resolved
  // path to land in.
  if (intent === 'launch') {
    push(args, '--worktree', launch.worktree);
  }
  push(args, '--append-system-prompt', launch.appendSystemPrompt);
  return args;
}

function push(args: string[], flag: string, value: string | null): void {
  if (value !== null) {
    args.push(flag, value);
  }
}
