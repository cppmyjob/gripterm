import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

/** What Windows tries when a name has no extension, and `PATHEXT` is somehow not set. */
const DEFAULT_PATH_EXT = '.COM;.EXE;.BAT;.CMD';

const WINDOWS = 'win32';

export interface ExecutableSearch {
  /** `process.env.PATH`. */
  readonly path: string | undefined;
  /** `process.env.PATHEXT`. Read only where a bare name needs an extension. */
  readonly pathExt: string | undefined;
  /**
   * `process.platform`, and it decides ONE thing: whether a bare name may need
   * an extension. The `PATH` separator is deliberately not taken from here --
   * it is `node:path`'s own, because it is the platform's spelling and not a
   * decision of ours. A Windows path carries a colon inside it, so a separator
   * we chose ourselves could shred `C:\Program Files\nodejs` into two entries.
   */
  readonly platform: string;
}

/**
 * Where an executable actually is, by absolute path.
 *
 * Two callers, and both need the absolute answer rather than the name: the hook
 * forwarder is started by the CLI with the TERMINAL's environment, where a bare
 * `node` is not guaranteed (C5-2), and `claude` is started as the terminal
 * process itself, with no shell under it to resolve anything (§4.4).
 *
 * A relative entry in `PATH` is SKIPPED rather than resolved. Resolving it would
 * mean resolving against this process's working directory, which is not the one
 * the entry was written for -- and an answer that is absolute but wrong is worse
 * here than no answer, because it goes into a settings file and is read by
 * somebody else's process.
 *
 * `null` is an ordinary answer and not an error. What to do about a missing
 * interpreter is the caller's decision, and it differs: without `claude` there
 * is nothing to launch, while without `node` we lose one event and keep the
 * rest (§4.7).
 */
export async function findExecutable(
  name: string,
  search: ExecutableSearch
): Promise<string | null> {
  const directories = (search.path ?? '').split(delimiter).filter(usable);
  const names = candidates(name, search.platform === WINDOWS, search.pathExt);

  for (const directory of directories) {
    for (const candidate of names) {
      const full = join(directory, candidate);
      if (await isExecutableFile(full)) {
        return full;
      }
    }
  }
  return null;
}

/** A blank entry is not absolute either, so absoluteness is the whole of the test. */
function usable(directory: string): boolean {
  return isAbsolute(directory);
}

/**
 * The names to try in one directory.
 *
 * On Windows the bare name is offered ONLY when the caller already spelled an
 * extension. This is not tidiness: there, the extension IS the executable bit,
 * and a file called `claude` with no extension cannot be run at all -- while
 * `stat` says it is a file and `access(X_OK)` says yes to everything. Offering
 * it would hand back an absolute path to something that fails on execution, in
 * a settings file, in somebody else's process.
 *
 * A caller who did spell one is taken at their word: `claude.exe` means that
 * file, and appending `.COM` to it would be the lookup arguing with them.
 */
function candidates(name: string, windows: boolean, pathExt: string | undefined): string[] {
  if (!windows) {
    return [name];
  }
  const extensions = (pathExt ?? DEFAULT_PATH_EXT)
    .split(';')
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);
  const spelled = extensions.some((extension) => endsWith(name, extension));
  return spelled ? [name] : extensions.map((extension) => `${name}${extension}`);
}

/** Windows file names are case-insensitive, and `PATHEXT` is conventionally upper case. */
function endsWith(name: string, extension: string): boolean {
  return name.toLowerCase().endsWith(extension.toLowerCase());
}

/**
 * A file that exists and may be run.
 *
 * `stat` first, because on POSIX a directory carries the execute bit too and
 * `access` alone would offer one as something to run. `X_OK` after, and
 * unconditionally: on Windows the platform ignores it, which costs one syscall
 * and saves a branch that no test on a Windows machine could ever reach.
 */
async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const found = await stat(candidate);
    if (!found.isFile()) {
      return false;
    }
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    // Missing, unreadable, a directory, a broken link: all of them mean the
    // same thing to a caller looking for something to run.
    return false;
  }
}
