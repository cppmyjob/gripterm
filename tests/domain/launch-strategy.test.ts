import {
  ProcessLaunchStrategy,
  ShellLaunchStrategy,
  TerminalId,
  ValidationError,
  type AgentCommand,
  type LaunchStrategy,
} from '../../packages/core/src/index';
import { TERMINAL_UUID, captureError } from '../helpers/domain-fixtures';

/**
 * The oracle for turning an argument vector into a terminal.
 *
 * The two strategies are the two answers to ONE question -- is the agent the
 * terminal process, or a line typed into somebody's shell -- and the whole
 * value of separating them is that the answer is visible in the spec rather
 * than hidden in a launch procedure. So the tests are written as properties of
 * the pair, not as two independent descriptions.
 *
 * What neither may do is know a flag. `--session-id` never appears in this
 * file, and the linter enforces the same thing for the source: a strategy under
 * `domain/services/` that imported one CLI's knowledge fails the build.
 */

const TERMINAL = TerminalId.fromString(TERMINAL_UUID);

const COMMAND: AgentCommand = {
  executable: 'C:/Program Files/claude/claude.exe',
  args: ['--add-dir', 'D:/Projects/lib', '--settings', 'C:/Users/x/.gripterm/t/settings.json'],
  env: { GRIPTERM_TOKEN: 'a3f1', NODE_OPTIONS: '--no-warnings' },
};

function plan(strategy: LaunchStrategy, command: AgentCommand = COMMAND): ReturnType<LaunchStrategy['buildPlan']> {
  return strategy.buildPlan({
    terminalId: TERMINAL,
    name: 'auth-refactor',
    cwd: 'D:/Projects/foo',
    command,
  });
}

const BOTH: readonly (readonly [string, LaunchStrategy])[] = [
  ['process', new ProcessLaunchStrategy()],
  ['shell', new ShellLaunchStrategy('powershell')],
];

describe('both strategies agree on what does not depend on the mode', () => {
  it.each(BOTH)('%s carries the terminal, its name and its directory', (_label, strategy) => {
    const { spec } = plan(strategy);
    expect(spec.terminalId).toBe(TERMINAL);
    expect(spec.name).toBe('auth-refactor');
    expect(spec.cwd).toBe('D:/Projects/foo');
  });

  it.each(BOTH)('%s passes the environment through untouched', (_label, strategy) => {
    // Both modes get the environment the same way: `TerminalOptions.env`. The
    // token must never be typed into a shell where the scrollback would keep it.
    expect(plan(strategy).spec.env).toStrictEqual(COMMAND.env);
  });

  it.each(BOTH)('%s announces its own mode', (label, strategy) => {
    expect(strategy.mode).toBe(label);
  });

  it.each(BOTH)('%s produces a plan that cannot be edited afterwards', (_label, strategy) => {
    const built = plan(strategy);
    expect(() => ((built.spec as { name: string }).name = 'other')).toThrow(TypeError);
  });

  /**
   * The exclusivity that makes the pair worth having. A spec with both a
   * `shellPath` and an `initialInput` would run the agent AND type the command
   * line into it -- two sessions, one of them unobserved.
   */
  it.each(BOTH)('%s answers exactly one of the two questions', (_label, strategy) => {
    const { spec, initialInput } = plan(strategy);
    expect(spec.shellPath === null).toBe(initialInput !== null);
  });
});

describe('ProcessLaunchStrategy: the agent IS the terminal process', () => {
  it('puts the executable and its vector where the editor spawns them', () => {
    const { spec, initialInput } = plan(new ProcessLaunchStrategy());
    expect(spec.shellPath).toBe(COMMAND.executable);
    expect(spec.shellArgs).toStrictEqual(COMMAND.args);
    expect(initialInput).toBeNull();
  });

  it('passes the vector as a vector, so nothing is ever quoted', () => {
    // The whole of §4.4's win: `C:\Program Files\...` stays one argument, and
    // the shell-readiness race (A12) does not exist because there is no shell.
    const { spec } = plan(new ProcessLaunchStrategy());
    expect(spec.shellArgs.join('')).not.toContain(`'`);
    expect(spec.shellArgs.join('')).not.toContain('"');
  });
});

describe('ShellLaunchStrategy: the command is typed into the user shell', () => {
  it('leaves the shell to the editor and types the line afterwards', () => {
    const { spec, initialInput } = plan(new ShellLaunchStrategy('powershell'));
    expect(spec.shellPath).toBeNull();
    expect(spec.shellArgs).toStrictEqual([]);
    expect(initialInput).toBe(
      `& 'C:/Program Files/claude/claude.exe' '--add-dir' 'D:/Projects/lib' '--settings' 'C:/Users/x/.gripterm/t/settings.json'`
    );
  });

  it('quotes for the shell it was told about, not for the host platform', () => {
    expect(plan(new ShellLaunchStrategy('posix')).initialInput).toBe(
      `'C:/Program Files/claude/claude.exe' '--add-dir' 'D:/Projects/lib' '--settings' 'C:/Users/x/.gripterm/t/settings.json'`
    );
    expect(plan(new ShellLaunchStrategy('cmd')).initialInput).toContain(
      `"C:/Program Files/claude/claude.exe"`
    );
  });

  it('refuses rather than typing a line the shell would mangle', () => {
    // The failing case is real: an `--append-system-prompt` holding a double
    // quote reaches Windows PowerShell and arrives with the quote gone.
    const withQuote: AgentCommand = { ...COMMAND, args: ['--append-system-prompt', 'say "hi"'] };
    expect(captureError(() => plan(new ShellLaunchStrategy('powershell'), withQuote))).toBeInstanceOf(
      ValidationError
    );
  });

  it('never reorders or drops an argument it was given', () => {
    // Not a split on spaces: the executable path holds one, which is the very
    // reason quoting exists. Order is checked by where each quoted argument
    // lands in the line.
    const line = plan(new ShellLaunchStrategy('posix')).initialInput ?? '';
    const positions = [COMMAND.executable, ...COMMAND.args].map((part) =>
      line.indexOf(`'${part}'`)
    );
    expect(positions).not.toContain(-1);
    expect([...positions].sort((a, b) => a - b)).toStrictEqual(positions);
  });
});
