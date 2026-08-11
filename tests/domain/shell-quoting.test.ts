import {
  SHELL_KINDS,
  ValidationError,
  isShellKind,
  quoteForShell,
  shellCommandLine,
  type ShellKind,
} from '../../packages/core/src/index';
import { captureError } from '../helpers/domain-fixtures';

/**
 * The oracle for typing a command line into somebody else's shell.
 *
 * Every row was MEASURED on 2026-08-11 rather than read from a manual, because
 * the failure mode here is not an error but a mangled argument: a settings path
 * that loses a character launches an agent nobody observes, and the terminal
 * looks perfectly healthy while doing it.
 *
 * The stand was a script printing its own `process.argv`, invoked from each
 * shell with the quoting under test (`scratchpad/argv/show-argv.js`). What it
 * showed:
 *
 *   bash 5.2.37        `'a "b" c'`  -> `a "b" c`   -- and `$HOME`, backticks,
 *                                                     `!`, `%`, `\` all intact
 *   pwsh 7.6.3         `'a "b" c'`  -> `a "b" c`
 *   Windows PowerShell `'a "b" c'`  -> `a b c`     <- the quotes VANISH
 *   cmd.exe            `"50%PATH%"` -> `50C:\...`  <- expanded INSIDE quotes
 *
 * The last two rows are why this module refuses characters instead of trying to
 * escape them. Windows PowerShell 5.1 re-serialises the argument vector on its
 * way to a native executable and drops embedded double quotes; cmd.exe expands
 * `%VAR%` at parse time, and quoting does not stop it -- there is no interactive
 * escape for `%` at all. A refusal is loud. A dropped character is not.
 */

const EXECUTABLE_POSIX = '/home/x/.local/bin/claude';
const EXECUTABLE_WINDOWS = 'C:\\Program Files\\claude\\claude.exe';
const SETTINGS_PATH = 'C:\\Users\\Иван Петров\\.gripterm\\t\\settings.json';

describe('ShellKind', () => {
  it('names exactly the three shells a VS Code terminal can be on', () => {
    expect([...SHELL_KINDS]).toStrictEqual(['posix', 'powershell', 'cmd']);
  });

  it('recognises its own members and nothing else', () => {
    for (const kind of SHELL_KINDS) {
      expect(isShellKind(kind)).toBe(true);
    }
    for (const other of ['bash', 'pwsh', 'PowerShell', '', 'sh']) {
      expect(isShellKind(other)).toBe(false);
    }
  });
});

describe('quoteForShell', () => {
  const CASES: readonly (readonly [ShellKind, string, string])[] = [
    // posix -- single quotes are literal, so only the quote itself needs work.
    ['posix', 'claude', `'claude'`],
    ['posix', 'a b c', `'a b c'`],
    ['posix', '', `''`],
    ['posix', `it's`, `'it'\\''s'`],
    ['posix', 'a "b" c', `'a "b" c'`],
    ['posix', '$HOME `id` !x', '\'$HOME `id` !x\''],
    ['posix', '50%PATH%', `'50%PATH%'`],
    ['posix', 'C:\\Program Files\\x', `'C:\\Program Files\\x'`],

    // powershell -- single quotes are literal here too; the quote doubles.
    ['powershell', 'claude', `'claude'`],
    ['powershell', 'a b c', `'a b c'`],
    ['powershell', '', `''`],
    ['powershell', `it's`, `'it''s'`],
    ['powershell', '50%PATH%', `'50%PATH%'`],
    ['powershell', '$env:X', `'$env:X'`],
    ['powershell', 'C:\\Program Files\\x', `'C:\\Program Files\\x'`],

    // cmd -- double quotes suppress `&`, `|`, `<`, `>`, `^`; `%` is refused below.
    ['cmd', 'claude', `"claude"`],
    ['cmd', 'a b c', `"a b c"`],
    ['cmd', '', `""`],
    ['cmd', `it's`, `"it's"`],
    ['cmd', 'a & b | c ^ d', `"a & b | c ^ d"`],
    ['cmd', 'C:\\Program Files\\x', `"C:\\Program Files\\x"`],
  ];

  it.each(CASES)('%s: %j -> %j', (shell, value, expected) => {
    expect(quoteForShell(value, shell)).toBe(expected);
  });

  /**
   * A quoted argument is only worth anything if what comes back out is what
   * went in. The round trip is modelled here from the measured behaviour of
   * each shell's literal-quote form, which is the one property the table above
   * relies on and the one a future edit is most likely to break.
   */
  it.each(CASES)('%s: %j survives being unquoted again', (shell, value) => {
    expect(unquote(quoteForShell(value, shell), shell)).toBe(value);
  });
});

describe('quoteForShell refuses what its shell cannot carry', () => {
  const UNIVERSAL = ['a\nb', 'a\rb', 'a\0b'];

  it.each(SHELL_KINDS.flatMap((shell) => UNIVERSAL.map((value) => [shell, value] as const)))(
    '%s refuses %j -- a typed line ends at the newline',
    (shell, value) => {
      expect(captureError(() => quoteForShell(value, shell))).toBeInstanceOf(ValidationError);
    }
  );

  it('powershell refuses a double quote -- Windows PowerShell 5.1 drops it', () => {
    expect(captureError(() => quoteForShell('say "hi"', 'powershell'))).toBeInstanceOf(
      ValidationError
    );
  });

  it('cmd refuses a percent sign -- it expands inside quotes and cannot be escaped', () => {
    expect(captureError(() => quoteForShell('50%PATH%', 'cmd'))).toBeInstanceOf(ValidationError);
  });

  it('cmd refuses a double quote -- nesting quotes in cmd has no sound spelling', () => {
    expect(captureError(() => quoteForShell('say "hi"', 'cmd'))).toBeInstanceOf(ValidationError);
  });

  it('names the shell and the character it refused', () => {
    const error = captureError(() => quoteForShell('50%PATH%', 'cmd'));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).details).toMatchObject({ shell: 'cmd' });
  });

  it('posix carries every character the other two refuse', () => {
    expect(quoteForShell('say "hi" 50%PATH%', 'posix')).toBe(`'say "hi" 50%PATH%'`);
  });
});

describe('shellCommandLine', () => {
  it('prefixes the powershell line with the call operator', () => {
    // Measured: `'C:\...\node.exe' script` is a parse error in Windows
    // PowerShell ("Unexpected token"); `& 'C:\...\node.exe' script` runs. A
    // quoted command word is a STRING expression there, not a command.
    expect(shellCommandLine(EXECUTABLE_WINDOWS, ['--settings', SETTINGS_PATH], 'powershell')).toBe(
      `& 'C:\\Program Files\\claude\\claude.exe' '--settings' '${SETTINGS_PATH}'`
    );
  });

  it('does not prefix posix, where a quoted command word executes', () => {
    expect(shellCommandLine(EXECUTABLE_POSIX, ['--settings', '/etc/s.json'], 'posix')).toBe(
      `'/home/x/.local/bin/claude' '--settings' '/etc/s.json'`
    );
  });

  it('does not prefix cmd, where a quoted command word executes', () => {
    expect(shellCommandLine(EXECUTABLE_WINDOWS, ['--settings', 'C:\\s.json'], 'cmd')).toBe(
      `"C:\\Program Files\\claude\\claude.exe" "--settings" "C:\\s.json"`
    );
  });

  it('quotes the executable as well as the arguments', () => {
    // `C:\Program Files\` unquoted is two arguments, and the failure is a
    // launch that reports a missing file nobody can find by eye.
    expect(shellCommandLine(EXECUTABLE_WINDOWS, [], 'cmd')).toContain(`"${EXECUTABLE_WINDOWS}"`);
  });

  it('refuses the whole line when one argument is unrepresentable', () => {
    expect(
      captureError(() => shellCommandLine(EXECUTABLE_WINDOWS, ['--x', '50%PATH%'], 'cmd'))
    ).toBeInstanceOf(ValidationError);
  });
});

/**
 * The inverse of each shell's literal-quote form, written independently of the
 * implementation so the round-trip test above cannot pass by sharing a bug with
 * it.
 */
function unquote(quoted: string, shell: ShellKind): string {
  const body = quoted.slice(1, -1);
  switch (shell) {
    case 'posix':
      return body.split(`'\\''`).join(`'`);
    case 'powershell':
      return body.split(`''`).join(`'`);
    case 'cmd':
      return body;
  }
}
