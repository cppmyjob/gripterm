import { SHELL_KINDS } from './shell-quoting';
import type { ShellKind } from './shell-quoting';

const SEPARATORS = /[/\\]+/u;

/**
 * Program names, by parsing family. Only the two Windows shells are listed,
 * because they are the only ones that do not quote the POSIX way -- and they are
 * the only ones a name can identify with certainty.
 */
const FAMILIES: Readonly<Record<string, ShellKind>> = {
  powershell: 'powershell',
  pwsh: 'powershell',
  cmd: 'cmd',
};

const EXECUTABLE_SUFFIX = '.exe';

/**
 * Which quoting family a shell belongs to, from the path the editor reports.
 *
 * Used on ONE path: `gripterm.launch.mode: shell`, where the agent's command
 * line is typed into somebody's shell instead of being the terminal's process.
 * The default mode needs none of this -- there is no shell to quote for (§4.4).
 *
 * ANYTHING UNRECOGNISED IS POSIX, and on Windows too. That is not a guess about
 * the machine: `cmd` and PowerShell are exactly the shells whose names are
 * fixed and known, so a Windows shell we cannot name is a bash, a zsh or a fish
 * shipped with Git, WSL or a package manager -- all of which quote alike. The
 * cost of being wrong is bounded in the right direction: `shell-quoting`
 * REFUSES the characters it cannot carry, so a wrong family fails loudly at the
 * launch rather than silently losing a quote inside an argument.
 */
export function shellKindFor(shellPath: string | undefined): ShellKind {
  const name = (shellPath ?? '')
    .split(SEPARATORS)
    .filter((part) => part.length > 0)
    .at(-1)
    ?.toLowerCase();

  if (name === undefined) {
    return SHELL_KINDS[0];
  }
  const bare = name.endsWith(EXECUTABLE_SUFFIX)
    ? name.slice(0, -EXECUTABLE_SUFFIX.length)
    : name;
  return FAMILIES[bare] ?? SHELL_KINDS[0];
}
