import { ValidationError } from '../errors/gripterm-error';

/**
 * The three ways a VS Code terminal parses a line typed into it.
 *
 * Named by PARSING FAMILY rather than by program: `bash`, `zsh`, `sh`, `fish`
 * and Git Bash all quote alike, and `pwsh` and Windows PowerShell differ in what
 * they SURVIVE (see below) but not in how they quote. The adapter that reads the
 * terminal profile maps its own names onto these three.
 */
export const SHELL_KINDS = ['posix', 'powershell', 'cmd'] as const;

export type ShellKind = (typeof SHELL_KINDS)[number];

export function isShellKind(value: string): value is ShellKind {
  return (SHELL_KINDS as readonly string[]).includes(value);
}

/**
 * Characters no shell can carry on a line that is typed and then executed by a
 * newline. `\0` cannot travel through a terminal at all; `\n` and `\r` end the
 * command, so an argument holding one would run its own tail as a second
 * command -- the worst possible failure for a string we did not author.
 */
const UNIVERSALLY_REFUSED = ['\0', '\n', '\r'] as const;

interface ShellDialect {
  /** Characters this shell in particular cannot carry, beyond the universal three. */
  readonly refuses: readonly string[];
  readonly quote: (value: string) => string;
  /** Typed before the executable. Empty where a quoted command word already executes. */
  readonly callPrefix: string;
}

const DIALECTS: Readonly<Record<ShellKind, ShellDialect>> = {
  /**
   * Single quotes are literal in every POSIX shell, including the quote itself
   * once the argument is broken around it: `'` closes, `\'` supplies a literal
   * quote, `'` reopens. Nothing else needs a rule -- measured 2026-08-11 on bash
   * 5.2.37, where `$HOME`, backticks, `!`, `%`, `"` and `\` all arrived intact.
   */
  posix: {
    refuses: [],
    quote: (value) => `'${value.replaceAll(`'`, `'\\''`)}'`,
    callPrefix: '',
  },

  /**
   * Single quotes are literal here too, and the quote doubles to escape itself.
   *
   * The double quote is REFUSED rather than escaped. Measured 2026-08-11: the
   * same `'a "b" c'` reached the process intact under pwsh 7.6.3 and arrived as
   * `a b c` under Windows PowerShell 5.1, which re-serialises the argument
   * vector on its way to a native executable and loses embedded quotes. Since
   * the shell mode exists for machines whose environment we do not control, the
   * older parser is the one we must survive, and a character that vanishes on
   * half the machines is worse than a launch that refuses out loud.
   */
  powershell: {
    refuses: ['"'],
    quote: (value) => `'${value.replaceAll(`'`, `''`)}'`,
    /**
     * Without it, a quoted command word is a STRING EXPRESSION and not a
     * command. Measured 2026-08-11: `'C:\...\node.exe' script` is a parse error
     * ("Unexpected token"), `& 'C:\...\node.exe' script` runs.
     */
    callPrefix: '& ',
  },

  /**
   * Double quotes suppress `&`, `|`, `<`, `>` and `^`, and that is the whole of
   * what cmd offers.
   *
   * `%` is refused because quoting does NOT stop expansion -- measured
   * 2026-08-11: `"50%PATH%"` reached the process as `50C:\Program Files\...`.
   * There is no interactive escape for it (`%%` works only inside a batch file),
   * so refusal is not a shortcut here but the only truthful answer. The double
   * quote is refused for the same reason it is under PowerShell: cmd has no
   * sound spelling for a nested one.
   */
  cmd: {
    refuses: ['%', '"'],
    quote: (value) => `"${value}"`,
    callPrefix: '',
  },
};

/**
 * One argument, quoted so that the shell hands it to the executable unchanged.
 *
 * Throws rather than escapes when the shell cannot represent a character. The
 * asymmetry is deliberate: every failure this module prevents is SILENT. A
 * settings path that loses a character launches an agent that runs perfectly
 * and is never observed, and no log anywhere says why.
 */
export function quoteForShell(value: string, shell: ShellKind): string {
  const dialect = DIALECTS[shell];
  for (const character of [...UNIVERSALLY_REFUSED, ...dialect.refuses]) {
    if (value.includes(character)) {
      throw new ValidationError(
        `a ${shell} command line cannot carry ${JSON.stringify(character)}`,
        { details: { shell, character, value } }
      );
    }
  }
  return dialect.quote(value);
}

/**
 * The whole line to type into a shell: the executable and its argument vector,
 * each quoted, with whatever prefix this shell needs in order to treat the first
 * token as a command.
 *
 * Only `gripterm.launch.mode: shell` reaches here. The default mode makes the
 * agent the terminal process itself and passes the vector as a vector, which is
 * why §4.4 calls quoting a cost of the fallback rather than of the design.
 */
export function shellCommandLine(
  executable: string,
  args: readonly string[],
  shell: ShellKind
): string {
  const line = [executable, ...args].map((part) => quoteForShell(part, shell)).join(' ');
  return `${DIALECTS[shell].callPrefix}${line}`;
}
