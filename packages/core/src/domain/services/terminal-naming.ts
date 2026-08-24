/**
 * Where a name comes from when the person has not given one yet.
 *
 * A word about the ROLE and not about one product: this row could be running
 * Claude Code or the next agent along, and the list would read the same either
 * way. Only a terminal whose cwd names no folder ever gets it.
 */
const FALLBACK = 'agent';

/** Both separators, always. A Windows path reaches us through settings and through the editor, and only one of the two forms is native. */
const SEPARATORS = /[/\\]+/u;

/**
 * The name a new terminal gets before anybody renames it (M2.7).
 *
 * The folder rather than a number, because the list exists to be scanned: "foo"
 * and "bar" are told apart at a glance where "Terminal 1" and "Terminal 2" have
 * to be read and remembered.
 *
 * Uniqueness is not decoration either. Two terminals in one folder is the normal
 * case -- one writing code, one running tests -- and two rows with the same
 * label in a list whose whole job is telling terminals apart is the defect the
 * list was built to remove. The suffix counts up until it finds a free name
 * rather than counting the entries, so a name freed by a close is reused instead
 * of leaving a gap that grows for the life of the window.
 */
export function defaultTerminalName(cwd: string, taken: readonly string[]): string {
  const base = folderName(cwd);
  if (!taken.includes(base)) {
    return base;
  }
  // From 2: the unsuffixed name IS the first one.
  for (let ordinal = 2; ; ordinal += 1) {
    const candidate = `${base} ${ordinal.toString()}`;
    if (!taken.includes(candidate)) {
      return candidate;
    }
  }
}

/**
 * The last segment of a path.
 *
 * A drive root gets the fallback rather than its own spelling: `D:\` would
 * otherwise put a terminal called `D:` in the list, which reads as a mistake
 * because it is one -- there is no folder there to name it after.
 */
function folderName(cwd: string): string {
  const segments = cwd.split(SEPARATORS).filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  if (last === undefined || last.endsWith(':')) {
    return FALLBACK;
  }
  return last;
}
