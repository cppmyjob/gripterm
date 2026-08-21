import { arranged, reorderTerminals } from './terminal-order';
import type { TerminalEntry } from '../entities/terminal-entry';
import type { TerminalGroup } from './terminal-grouping';
import type { TerminalId } from '../entities/terminal-id';

/**
 * A row of the list dragged to another place in it.
 *
 * **The owner, 2026-08-21**, after the tabs of the panel became draggable: "не
 * реализован drag and drop в tree view где список всех терминалов". The
 * arrangement it changes is the same one -- `terminal-order`, one number per
 * record, one arrangement for the panel and the list both, which is what the
 * owner asked for the same day.
 *
 * **What this file adds is the refusals**, and they exist because the list is
 * not the strip. The strip draws the terminals of THIS window; every tab on it
 * is ours to write. The list draws every terminal on the machine (par. 0),
 * grouped by the project each belongs to, and a window may write only its own
 * records (par. 4.8). So a drop in the list can be a thing this window is not
 * allowed to do, and the answer has to say WHICH thing:
 *
 *   * `not-ours` -- the row belongs to another window. Its file is not ours.
 *   * `other-project` -- the row was let go under a different heading. A
 *     terminal's project is the folder of the window that made it; a row that
 *     moved heading would be a lie about who answers for it.
 *   * `no-room` -- see below.
 *   * `nowhere` -- let go over empty space, or over a row that has since gone.
 *
 * **`no-room` is the one that is a price rather than a rule.** Two neighbours
 * made within two milliseconds of each other leave no room between them, and
 * the answer to that -- writing the whole arrangement out again -- is one this
 * window may give only for its own records. In the strip that is always true.
 * In the list it is not, and the drop is then refused WHOLE: half an
 * arrangement is an order nobody asked for, and it would be silent. It is
 * removable the day a record carries its arrangement relative to its group
 * rather than as a number two windows share.
 */

export type TreeDropTarget =
  | { readonly kind: 'row', readonly terminalId: TerminalId }
  | { readonly kind: 'heading', readonly key: string };

export type TreeDropRefusal = 'nowhere' | 'not-ours' | 'other-project' | 'no-room';

export interface TreeDropRequest {
  /** The list as it is drawn, headings and all. */
  readonly groups: readonly TerminalGroup[];
  readonly moved: TerminalId;
  /** What the pointer was over when the person let go, or `null` for nothing. */
  readonly target: TreeDropTarget | null;
  /** Whether a record is this window's to write (par. 4.8). */
  readonly owns: (terminalId: TerminalId) => boolean;
}

export interface TreeDrop {
  /** The records to amend: empty when nothing moved, and when nothing may. */
  readonly changed: readonly TerminalEntry[];
  readonly refusal: TreeDropRefusal | null;
}

const REFUSED = (refusal: TreeDropRefusal): TreeDrop => ({ changed: [], refusal });

export function dropInTree(request: TreeDropRequest): TreeDrop {
  const { groups, moved, target, owns } = request;
  if (target === null) {
    return REFUSED('nowhere');
  }
  const group = groups.find((one) =>
    one.entries.some((entry) => entry.terminalId.equals(moved)));
  if (group === undefined) {
    // A row that is no longer in the list. The list is redrawn from the
    // registry on every change, so this is a drag that outlived its record --
    // a window closing under somebody's hand, and nothing to be done about it.
    return REFUSED('nowhere');
  }
  if (!owns(moved)) {
    return REFUSED('not-ours');
  }

  // Arranged here rather than trusted from the caller: the order a group is
  // handed over in is `groupTerminals`' business, and the index below is
  // counted in the order the person is LOOKING at.
  const rows = arranged(group.entries);
  const toIndex = landing(rows, group, target);
  if (toIndex === null) {
    return REFUSED('other-project');
  }

  const changed = reorderTerminals({ entries: rows, moved, toIndex });
  return changed.every((entry) => owns(entry.terminalId))
    ? { changed, refusal: null }
    : REFUSED('no-room');
}

/**
 * Where the dragged row ends up, counted in the list AFTER the move, or `null`
 * when the person let go somewhere this window cannot answer for.
 *
 * **Dropped on a row: the place that row is standing in.** The editor marks a
 * whole row rather than a gap between two -- there is no insertion line in a
 * tree the way there is on our own strip -- so "where I dropped it is where it
 * goes" is the only reading of the mark a person is given. It comes out
 * symmetric: dragging up lands above the row that was marked, dragging down
 * lands below it, and either way the dragged row occupies the place the eye was
 * on.
 */
function landing(
  rows: readonly TerminalEntry[],
  group: TerminalGroup,
  target: TreeDropTarget
): number | null {
  if (target.kind === 'heading') {
    // A heading is the top of its own list. Dropping a row on the heading of
    // another project is the same refusal as dropping it on a row there.
    return target.key === group.key ? 0 : null;
  }
  const index = rows.findIndex((entry) => entry.terminalId.equals(target.terminalId));
  return index === -1 ? null : index;
}
