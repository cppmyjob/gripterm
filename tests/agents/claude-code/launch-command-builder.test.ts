import {
  LaunchCommandBuilder,
  LaunchRecipe,
  PERMISSION_MODES,
  TOKEN_ENV_VAR,
  ValidationError,
  type AgentCommand,
  type LaunchCommandParams,
  type LaunchIntent,
  type LaunchRecipeParams,
} from '../../../packages/core/src/index';
import { SESSION_UUID, captureError, makeEntry } from '../../helpers/domain-fixtures';

/**
 * The oracle for the argument vector.
 *
 * Two of its three duties fail SILENTLY when broken, which is why they are
 * asserted here as properties and not as a golden string:
 *
 *  1. The two launch paths take DISJOINT identity flags. `--session-id` on a
 *     resume is refused by the CLI's own validator ("Session ID ... is already
 *     in use"), and since `TerminalEntry.sessionId` is always populated, the
 *     natural implementation -- assemble the flags from the entry -- puts it on
 *     both paths and makes every restore die on startup [binary 2.1.224, §4.4].
 *  2. Variadic options swallow whatever follows them. `--add-dir` and
 *     `--mcp-config` are declared `<directories...>` / `<configs...>` and eat
 *     every token up to the next flag [measured, A2 2026-08-10]. A prompt lost
 *     that way produces no error at all -- the session simply starts empty.
 */

const EXECUTABLE = 'C:/Users/x/.local/bin/claude.exe';
const SETTINGS_PATH = 'C:/Users/x/.gripterm/terminals/t/settings.json';
const TOKEN = 'a3f1-not-a-real-token';

function recipe(overrides: Partial<LaunchRecipeParams> = {}): LaunchRecipe {
  return LaunchRecipe.create({
    cwd: 'D:/Projects/foo',
    addDirs: [],
    permissionMode: null,
    agent: null,
    model: null,
    worktree: null,
    mcpConfigPaths: [],
    appendSystemPrompt: null,
    extraEnv: {},
    ...overrides,
  });
}

function build(
  intent: LaunchIntent,
  overrides: Partial<LaunchCommandParams> = {},
  launch: LaunchRecipe = recipe()
): AgentCommand {
  return new LaunchCommandBuilder().build({
    executablePath: EXECUTABLE,
    entry: makeEntry({ launch }),
    intent,
    settingsPath: SETTINGS_PATH,
    token: TOKEN,
    ...overrides,
  });
}

/** The value the CLI would see for `flag`, or `undefined` when it is absent. */
function valueOf(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

describe('LaunchCommandBuilder: the two paths take disjoint identity flags', () => {
  it('a new terminal is launched with --session-id and no --resume', () => {
    const { args } = build('launch');
    expect(valueOf(args, '--session-id')).toBe(SESSION_UUID);
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('--fork-session');
  });

  it('a restore is launched with --resume and no --session-id', () => {
    const { args } = build('resume');
    expect(valueOf(args, '--resume')).toBe(SESSION_UUID);
    // The mine of §4.4: the entry HAS a sessionId on this path too, and passing
    // it is what the CLI's validator refuses.
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--fork-session');
  });

  it('carries the terminal executable it was given', () => {
    expect(build('launch').executable).toBe(EXECUTABLE);
  });
});

describe('LaunchCommandBuilder: observation is installed on both paths', () => {
  it.each<LaunchIntent>(['launch', 'resume'])('%s passes --settings', (intent) => {
    expect(valueOf(build(intent).args, '--settings')).toBe(SETTINGS_PATH);
  });

  it.each<LaunchIntent>(['launch', 'resume'])(
    '%s ends with --settings, so no variadic option can be last',
    (intent) => {
      const { args } = build(intent, {}, recipe({ addDirs: ['D:/a'], mcpConfigPaths: ['D:/m.json'] }));
      expect(args.slice(-2)).toStrictEqual(['--settings', SETTINGS_PATH]);
    }
  );

  it('passes the settings file as a path, never as inline JSON', () => {
    // §4.4: inline JSON through a shell is where the quoting bugs live, and a
    // file can be opened by a human when something breaks.
    expect(valueOf(build('launch').args, '--settings')).not.toContain('{');
  });
});

describe('LaunchCommandBuilder: a positional argument survives the variadic options', () => {
  /**
   * Commander's variadic rule as MEASURED in A2, applied to the vector this
   * builder produces plus a trailing prompt. Written as a model rather than as
   * an index assertion because the property that matters is the CLI's, not the
   * builder's: what must hold is that the prompt is still an operand.
   */
  const VARIADIC = ['--add-dir', '--mcp-config'];

  function operandsOf(args: readonly string[]): string[] {
    const operands: string[] = [];
    let index = 0;
    while (index < args.length) {
      const token = args[index] ?? '';
      index += 1;
      if (VARIADIC.includes(token)) {
        while (index < args.length && !(args[index] ?? '').startsWith('-')) {
          index += 1;
        }
      } else if (token.startsWith('-')) {
        index += 1;
      } else {
        operands.push(token);
      }
    }
    return operands;
  }

  it('is not eaten when both variadic options are present', () => {
    const { args } = build(
      'launch',
      {},
      recipe({ addDirs: ['D:/a', 'D:/b'], mcpConfigPaths: ['D:/m.json'] })
    );
    expect(operandsOf([...args, 'the prompt'])).toStrictEqual(['the prompt']);
  });

  it('is not eaten when the recipe is empty', () => {
    expect(operandsOf([...build('launch').args, 'the prompt'])).toStrictEqual(['the prompt']);
  });

  it('the model can actually fail -- a variadic option left last eats it', () => {
    // Proof that the two assertions above are not vacuous.
    expect(operandsOf(['--add-dir', 'D:/a', 'the prompt'])).toStrictEqual([]);
  });
});

describe('LaunchCommandBuilder: the recipe becomes flags', () => {
  it('emits one variadic --add-dir carrying every directory', () => {
    const { args } = build('launch', {}, recipe({ addDirs: ['D:/a', 'D:/b'] }));
    const at = args.indexOf('--add-dir');
    expect(args.slice(at, at + 3)).toStrictEqual(['--add-dir', 'D:/a', 'D:/b']);
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(1);
  });

  it('emits one variadic --mcp-config carrying every path', () => {
    const { args } = build('launch', {}, recipe({ mcpConfigPaths: ['D:/m.json', 'D:/n.json'] }));
    const at = args.indexOf('--mcp-config');
    expect(args.slice(at, at + 3)).toStrictEqual(['--mcp-config', 'D:/m.json', 'D:/n.json']);
  });

  it.each([...PERMISSION_MODES])('passes the permission mode %s through unchanged', (mode) => {
    // Unchanged is the point: `default` is not one of the CLI's six values and
    // any translation table here would be the place it got reinvented [§03].
    expect(valueOf(build('launch', {}, recipe({ permissionMode: mode })).args, '--permission-mode')).toBe(mode);
  });

  it('maps the remaining scalar fields onto their flags', () => {
    const { args } = build(
      'launch',
      {},
      recipe({ agent: 'reviewer', model: 'opus', appendSystemPrompt: 'be terse' })
    );
    expect(valueOf(args, '--agent')).toBe('reviewer');
    expect(valueOf(args, '--model')).toBe('opus');
    expect(valueOf(args, '--append-system-prompt')).toBe('be terse');
  });

  it('emits nothing at all for the fields a recipe left empty', () => {
    const { args } = build('launch');
    for (const absent of [
      '--add-dir',
      '--mcp-config',
      '--permission-mode',
      '--agent',
      '--model',
      '--append-system-prompt',
      '--worktree',
    ]) {
      expect(args).not.toContain(absent);
    }
  });

  it('creates the worktree on launch and never on resume', () => {
    const withWorktree = recipe({ worktree: 'feature-x' });
    expect(valueOf(build('launch', {}, withWorktree).args, '--worktree')).toBe('feature-x');
    // `--worktree` means CREATE one. A restore joins the worktree that already
    // exists, by cwd; asking for it again would branch a second time.
    expect(build('resume', {}, withWorktree).args).not.toContain('--worktree');
  });
});

describe('LaunchCommandBuilder: the environment', () => {
  it('carries the activation token under the name the settings file reads', () => {
    expect(build('launch').env[TOKEN_ENV_VAR]).toBe(TOKEN);
  });

  it('carries the recipe environment alongside it', () => {
    const { env } = build('launch', {}, recipe({ extraEnv: { NODE_OPTIONS: '--no-warnings' } }));
    expect(env.NODE_OPTIONS).toBe('--no-warnings');
    expect(env[TOKEN_ENV_VAR]).toBe(TOKEN);
  });

  it('takes away the markers of the session that started the editor', () => {
    /*
     * A28, measured 2026-08-13, and the second defect the acceptance run of
     * M2.16 found. A person who types `code .` inside a Claude Code terminal
     * gives their editor that session's environment, and every terminal we open
     * inherits it. With `CLAUDE_CODE_CHILD_SESSION` present the CLI writes NO
     * transcript and no history line at all -- so the conversation cannot be
     * resumed by anybody, ours or theirs, and the failure is silent.
     *
     * Removal and not an empty string: an empty `CLAUDECODE` is still a
     * `CLAUDECODE`, and the editor's own port takes `null` for "unset this"
     * (`TerminalOptions.env`).
     */
    const { env } = build('launch');

    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeNull();
    expect(env.CLAUDECODE).toBeNull();
    expect(env.CLAUDE_CODE_SSE_PORT).toBeNull();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeNull();
    expect(env.CLAUDE_PID).toBeNull();
  });

  it('lets a recipe put back a marker it names on purpose', () => {
    // The removal list is a default against junk nobody asked for; a recipe is
    // somebody saying what this terminal is to have. Explicit beats default, so
    // the removals go in first and the recipe over them.
    const { env } = build('launch', {}, recipe({ extraEnv: { CLAUDE_PROJECT_DIR: 'D:/Projects/foo' } }));

    expect(env.CLAUDE_PROJECT_DIR).toBe('D:/Projects/foo');
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeNull();
  });

  it('leaves alone the variables a person sets on purpose', () => {
    // `CLAUDE_CONFIG_DIR` chooses the profile -- credentials, settings, the lot
    // -- and a person who set it means it. The rule is about the identity of a
    // RUN, not about configuration that happens to start with the same word.
    const { env } = build('launch');

    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('does not let a recipe overwrite the token', () => {
    // A recipe that shadowed it would authenticate as nothing and every event
    // would come back 401 -- a terminal that runs and is never seen.
    const { env } = build('launch', {}, recipe({ extraEnv: { [TOKEN_ENV_VAR]: 'stale' } }));
    expect(env[TOKEN_ENV_VAR]).toBe(TOKEN);
  });
});

describe('LaunchCommandBuilder: what it refuses', () => {
  it.each([
    ['executablePath', { executablePath: 'claude' }],
    ['settingsPath', { settingsPath: 'settings.json' }],
  ])('refuses a relative %s', (_field, overrides) => {
    expect(captureError(() => build('launch', overrides))).toBeInstanceOf(ValidationError);
  });

  it.each(['', '   '])('refuses a blank token %j', (token) => {
    expect(captureError(() => build('launch', { token }))).toBeInstanceOf(ValidationError);
  });

  it('accepts both spellings of absolute, because the file may be read elsewhere', () => {
    expect(() => build('launch', { executablePath: '/usr/local/bin/claude' })).not.toThrow();
  });
});

describe('LaunchCommandBuilder: the result cannot be edited afterwards', () => {
  it('freezes the argument vector and the environment', () => {
    const command = build('launch');
    expect(() => (command.args as string[]).push('--dangerously-skip-permissions')).toThrow(
      TypeError
    );
    expect(() => ((command.env as Record<string, string>).X = 'y')).toThrow(TypeError);
  });
});

/**
 * M2.19. The name a person gave the row, carried into the CLI's own view of the
 * conversation -- measured 2026-08-13: `claude --name X` puts `name: X` into
 * `~/.claude/sessions/<pid>.json` with NO `nameSource`, which is exactly what
 * `readSessionName` reads as "a person named this". So the two sides agree from
 * the first second instead of drifting until somebody types `/rename`.
 */
describe('LaunchCommandBuilder: the name the person gave the row', () => {
  it('is given to the CLI on launch', () => {
    const entry = makeEntry().withMetadata(makeEntry().metadata.withDisplayName('auth work'));

    expect(valueOf(build('launch', { entry }).args, '--name')).toBe('auth work');
  });

  it('is given again on a resume, because the CLI forgets it', () => {
    // Measured 2026-08-13: a resumed conversation comes back with a fresh
    // derived name. Without this flag the row and the CLI part company at every
    // restore.
    const entry = makeEntry().withMetadata(makeEntry().metadata.withDisplayName('auth work'));

    expect(valueOf(build('resume', { entry }).args, '--name')).toBe('auth work');
  });

  it('is the name the record has NOW, not the one it was created with', () => {
    const entry = makeEntry().withMetadata(makeEntry().metadata.withDisplayName('renamed since'));

    expect(valueOf(build('resume', { entry }).args, '--name')).toBe('renamed since');
  });

  it('does not eat the positional prompt', () => {
    // `--name <name>` takes exactly one token, but so does `--model`, and the
    // rule this file exists for is that nothing here may swallow what follows.
    const args = build('launch').args;

    expect(args[args.length - 1]).toBe(SETTINGS_PATH);
  });
});
