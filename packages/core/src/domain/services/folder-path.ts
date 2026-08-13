/**
 * What "the same folder" means, in the one place that answers it.
 *
 * Two callers need the answer and they must not disagree: the restore predicate
 * decides whether this window may bring a record back (§6), and the list decides
 * which project heading a row belongs under (M2.14). A second copy of this
 * comparison would drift exactly where nobody looks -- a person would be told
 * their terminal is in another project and, in the same window, that it cannot
 * be restored because it belongs to one.
 */

/** A drive letter or a UNC prefix -- the paths whose file systems ignore case. */
const WINDOWS_SHAPED = /^(?:[a-z]:|\\\\)/i;
const SEPARATORS = /[\\/]+/g;
const TRAILING_SEPARATOR = /\/+$/;

/**
 * The same folder, spelled by two different windows.
 *
 * Both spellings come from the same editor API on the same machine, so they
 * normally agree -- but a record outlives the window that wrote it, and a folder
 * opened as `d:\projects\x` from a shell and as `D:\Projects\X` from the
 * explorer is one folder to Windows. Refusing the second spelling would silently
 * withhold a whole feature from a person who did nothing wrong.
 *
 * Case is folded ONLY for Windows-shaped paths, decided by the string rather
 * than by a flag from the host. On a case-sensitive file system `/home/a` and
 * `/home/A` are two directories, and folding them would let one project's window
 * restore another's -- the G1 direction again. The cost is that a macOS user,
 * whose file system ignores case as well, gets a refusal where Windows gets a
 * restore; that is one click, and it is named in §8.2 rather than guessed at.
 */
export function sameFolder(left: string, right: string): boolean {
  return normalizeFolder(left) === normalizeFolder(right);
}

/**
 * One spelling of a folder, usable as a key.
 *
 * Never empty, and that is a rule rather than a detail: a posix root is nothing
 * but separators, and trimming them away would leave the empty string -- which
 * the list keeps for "no folder at all", and which would then put the terminals
 * of a window rooted at `/` under somebody else's heading.
 */
export function normalizeFolder(folder: string): string {
  const trimmed = folder.replace(SEPARATORS, '/').replace(TRAILING_SEPARATOR, '');
  const kept = trimmed.length === 0 ? '/' : trimmed;
  return WINDOWS_SHAPED.test(folder) ? kept.toLowerCase() : kept;
}

/**
 * Whether a record's folder is one this window has open.
 *
 * `null` belongs to a window with NO folders open. Anything else would make such
 * a record nobody's -- `null` is in no set of folders -- and it opens no theft
 * either, because `null` matches no real folder (§6).
 *
 * Membership is exact, not containment: a window with `D:\Projects` open does
 * not automatically own the terminals of `D:\Projects\thing`. Widening that is
 * the direction defect G1 came from.
 */
export function belongsHere(folder: string | null, windowFolders: readonly string[]): boolean {
  if (folder === null) {
    return windowFolders.length === 0;
  }
  return windowFolders.some((open) => sameFolder(open, folder));
}
