import { belongsHere, normalizeFolder } from './folder-path';
import type { TerminalEntry } from '../entities/terminal-entry';

/**
 * One project's heading in the list, and the terminals under it.
 *
 * Strings and records, no editor objects -- the same reason the presenter is
 * shaped this way (§3.5): `packages/extension` is outside the coverage
 * thresholds, so a rule taken there is a rule nothing checks. What remains on
 * the other side is a `TreeItem` per group.
 */
export interface TerminalGroup {
  /**
   * One folder, one key -- for the tree item's id, which is what the editor
   * keeps a person's expansion and selection state against.
   *
   * The empty string is reserved for the group of records with no folder at
   * all, which is why `normalizeFolder` never returns it.
   */
  readonly key: string;
  /** The folder as the first record naming it spells it, or `null` for none. */
  readonly folder: string | null;
  /** The last segment: what a person calls the project. */
  readonly label: string;
  /** The parent, so two projects with one name are still two projects. */
  readonly detail: string;
  /** Whether this window has that folder open. */
  readonly mine: boolean;
  /** In the order they arrived, which is the order they were created. */
  readonly entries: readonly TerminalEntry[];
}

/** The group of records belonging to a window that had no folder open. */
const FOLDERLESS_KEY = '';
const FOLDERLESS_LABEL = 'No folder';

interface Bucket {
  readonly folder: string | null;
  readonly entries: TerminalEntry[];
}

/**
 * The machine's terminals, under the projects they belong to (П4).
 *
 * Visibility is machine-global (§0): every window shows every terminal, and
 * without a heading a person with two editors open reads one list of rows whose
 * only difference is which window will answer for them. The grouping is what
 * makes that list readable, and the ORDER is what makes it stable:
 *
 *   * this window's own folders first, in the order the window has them, so the
 *     project somebody is working in is where their eye already is;
 *   * everything else by path, so two readings of one machine agree;
 *   * the folderless group last, because it is the rarest and the least
 *     actionable.
 *
 * A folder this window has open with no terminals in it gets NO group. An empty
 * heading is a chevron with nothing behind it, and the list of a person's
 * folders is what the explorer above this view already is.
 */
export function groupTerminals(
  entries: readonly TerminalEntry[],
  windowFolders: readonly string[]
): readonly TerminalGroup[] {
  const buckets = new Map<string, Bucket>();
  for (const entry of entries) {
    const folder = entry.owner.workspaceFolder;
    const key = folder === null ? FOLDERLESS_KEY : normalizeFolder(folder);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      // The first record naming a folder decides how the heading spells it.
      // Any of the spellings is the folder; picking one is what makes the
      // heading stable while records come and go.
      buckets.set(key, { folder, entries: [entry] });
    } else {
      bucket.entries.push(entry);
    }
  }

  return ordered(buckets, windowFolders).map(([key, bucket]) => ({
    key,
    folder: bucket.folder,
    ...naming(bucket.folder),
    mine: belongsHere(bucket.folder, windowFolders),
    entries: bucket.entries,
  }));
}

function ordered(
  buckets: ReadonlyMap<string, Bucket>,
  windowFolders: readonly string[]
): readonly (readonly [string, Bucket])[] {
  // Taken out of the map as they are placed, so a window that spells one folder
  // twice cannot produce one heading twice -- and so the remainder needs no
  // second bookkeeping to know what is left.
  const remaining = new Map(buckets);
  const first: (readonly [string, Bucket])[] = [];
  for (const open of windowFolders) {
    const key = normalizeFolder(open);
    const bucket = remaining.get(key);
    if (bucket !== undefined) {
      remaining.delete(key);
      first.push([key, bucket]);
    }
  }

  const folderless = remaining.get(FOLDERLESS_KEY);
  remaining.delete(FOLDERLESS_KEY);
  const rest = [...remaining.entries()].sort(([left], [right]) => (left < right ? -1 : 1));
  return folderless === undefined
    ? [...first, ...rest]
    : [...first, ...rest, [FOLDERLESS_KEY, folderless] as const];
}

/**
 * A path as a person reads it: the project, and where it is.
 *
 * The label is never empty, which is the only rule here that is not
 * cosmetic -- a group with no name is a heading nobody can tell from another,
 * and roots (`D:\`, `/`) are exactly the paths whose last segment is nothing.
 */
function naming(folder: string | null): { label: string, detail: string } {
  if (folder === null) {
    return { label: FOLDERLESS_LABEL, detail: '' };
  }
  const trimmed = folder.replace(/[\\/]+$/u, '');
  if (trimmed.length === 0) {
    // Nothing but separators: a posix root, which is its own name.
    return { label: folder, detail: '' };
  }
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut < 0
    ? { label: trimmed, detail: '' }
    : { label: trimmed.slice(cut + 1), detail: trimmed.slice(0, cut) };
}
