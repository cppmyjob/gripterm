import { ValidationError } from '../errors/gripterm-error';

/**
 * One node of the editor's layout tree: a group, or a group of groups.
 *
 * The shape `vscode.getEditorLayout` answers with and `vscode.setEditorLayout`
 * takes back, held here in the neutral spelling. `size` is in pixels and is
 * optional because the editor omits it for a group it has not laid out yet;
 * `groups` is absent on a leaf, and a leaf is what the editor calls a column.
 */
export interface EditorLayoutNode {
  readonly size?: number;
  readonly groups?: readonly EditorLayoutNode[];
}

export interface EditorLayout {
  readonly orientation: number;
  readonly groups: readonly EditorLayoutNode[];
}

interface Family {
  readonly siblings: readonly EditorLayoutNode[];
  readonly at: number;
  readonly node: EditorLayoutNode;
  /**
   * How that list is laid out: `COLUMNS` or `ROWS`.
   *
   * Carried here rather than answered by a second walk of the same tree,
   * because a second walk is a second place for the leaf counting to be wrong
   * -- and the leaf counting is the one thing every reader of this file has
   * got wrong at least once (see `withGroupShare`). `groupShare` and
   * `withGroupShare` do not read it; `amongRows` is nothing but it.
   */
  readonly orientation: number;
}

/**
 * How the editor lays a family of groups out. Measured, and the numbers are in
 * this repository twice over: a window in two columns answers `orientation: 0`
 * with sizes that add up to its WIDTH (426 + 426), and a strip made below
 * answers `orientation: 1` with sizes that add up to its HEIGHT (495 + 248).
 * Nested levels alternate, which is the editor's own rule for this shape.
 */
const COLUMNS = 0;
const ROWS = 1;

/**
 * The last leaf of the layout when that leaf is a ROW AT THE BOTTOM, counted
 * the way `ViewColumn` counts -- or `null` when the end of the area is not a
 * row at all.
 *
 * **The customer's window, 2026-08-22, in a screenshot they sent after three
 * rounds of my reading their words wrong.** The editor area was two COLUMNS:
 * their terminal full height on the left, `design.md` on the right. The log
 * beside it said `the terminals went into the empty group at the end of the
 * editor area {"column":2}`.
 *
 * That is the whole defect, and it was written down as an assumption in the
 * caller: "the end of the area and nothing else, because that is where a strip
 * is: it is made below the editors, so it is the last leaf of the grid". True
 * of a window laid out in rows. In a window laid out in COLUMNS the last leaf
 * is the right-hand column, and adopting it puts the terminals full height
 * beside the person's files -- "слева окажется окно терминала на всю высоту, а
 * справа файл".
 *
 * It also feeds itself: the editor restores the grid it was left with, so a
 * column adopted once comes back as a column next time and is adopted again.
 * That is the "иногда воспроизводится" and the "непонятно, как выйти".
 *
 * A leaf reached by descending through the LAST child of every level, at a
 * level laid out in rows, with something above it -- that is a strip, and
 * nothing else is.
 */
export function rowBelowAtTheEnd(layout: EditorLayout): number | null {
  let orientation = layout.orientation;
  let family = layout.groups;
  let before = 0;
  for (;;) {
    const last = family.at(-1);
    if (last === undefined) {
      return null;
    }
    for (const node of family.slice(0, -1)) {
      before += leavesIn(node);
    }
    if (last.groups === undefined) {
      // A family of one is a group with nothing above it, which is an editor
      // area holding one group -- not a strip, however it is oriented.
      return family.length > 1 && orientation === ROWS ? before : null;
    }
    family = last.groups;
    orientation = orientation === ROWS ? COLUMNS : ROWS;
  }
}

/**
 * Whether the group at `index` is a ROW AMONG ROWS -- the question
 * `rowBelowAtTheEnd` asks about the last leaf, asked about any leaf. `null`
 * when there is no such leaf.
 *
 * **What it is for, and the contradiction it removes (2026-08-25).** A strip of
 * ours is only ever made as a row below the editors, and `_emptyRowBelow`
 * refuses to adopt an empty group that is a COLUMN beside them -- the
 * customer's window of 2026-08-22, and the reason `rowBelowAtTheEnd` exists.
 * The sweep of leftovers in the same turn then closed exactly such a group: the
 * live suite of 2026-08-25 stood up two columns with the right-hand one empty,
 * opened a terminal, and the empty column was gone -- `the person's empty
 * column was taken instead of left alone`. Refusing to take a group and then
 * taking it away is one rule contradicting itself. What a restart leaves
 * behind of OURS is a row; a column beside the editors is somebody else's
 * furniture.
 *
 * A family of ONE answers `false`, for the reason `rowBelowAtTheEnd` gives
 * about the same shape: an editor area holding one group is nobody's strip,
 * however the grid is oriented, and there is nothing there to be among.
 *
 * `index` counts the LEAVES from the left, exactly as in `groupShare` -- a
 * `ViewColumn` minus one.
 */
export function amongRows(layout: EditorLayout, index: number): boolean | null {
  const family = familyOf(layout.groups, { index, seen: 0 }, layout.orientation);
  if (family === null) {
    return null;
  }
  return family.siblings.length > 1 && family.orientation === ROWS;
}

/**
 * How many COLUMNS the editor area has, counted from the grid.
 *
 * **Not the same number as `vscode.window.tabGroups.all.length`, measured
 * 2026-08-25 over nine runs of the stand.** Cursor keeps editors of its own in
 * an editor part that is not the main grid -- a "New Agent" tab, restored with
 * the window -- and the extension API lists that group beside the real ones,
 * with a `viewColumn` one past the last real column. Every rule that asks "does
 * the strip still have a neighbour" by counting tab groups counts that one too,
 * and the answer is wrong in the one direction that hurts: it closes the real
 * neighbour and leaves the strip alone in the editor area. The stand names the
 * disagreement in its own words -- "the editor holding a tab group outside its
 * own grid" -- and point 3 goes red about the consequence.
 *
 * The grid is the editor's own answer about its own area, so this is where the
 * number comes from -- and its ONE honest use is comparing it with the length
 * of that list. Equal, and every `viewColumn` means what it says. Unequal, and
 * which group is which cannot be told from here: the outsider was one past the
 * last column in 139 of the 142 sightings that had one and NOT in the rest, and
 * the grid answer lags the list during a restore -- `[743]`, one column, while
 * the editor was listing three groups. `VsCodeEditorStrip._areaGroups` moves
 * nothing when they disagree, for that reason.
 */
export function columnsIn(layout: EditorLayout): number {
  return layout.groups.reduce((sum, node) => sum + leavesIn(node), 0);
}

/** How many columns a node of the tree accounts for. */
function leavesIn(node: EditorLayoutNode): number {
  return node.groups === undefined ? 1 : node.groups.reduce((sum, one) => sum + leavesIn(one), 0);
}

/**
 * What the group at `index` holds of the space it shares, or `null` when the
 * editor has not sized that family yet.
 *
 * The companion `withGroupShare` needed: a caller can ASK for a third and has
 * no way to learn whether it got one. Measured in Cursor on 2026-08-22 --
 * `newGroupBelow` over an empty editor area, then `getEditorLayout` at once --
 * the editor answers with a layout it has not laid out, `withGroupShare` finds
 * nothing to divide and answers `null`, and the strip silently keeps the size
 * the split gave it: 673 pixels of 743, which is the customer's "терминал на
 * всю область файлов". Asking is not enough; this is what makes the asking
 * checkable.
 *
 * `null` is "the editor has not said", never "zero": a family whose sizes add
 * up to nothing is one the editor has not laid out, and treating that as a
 * share of zero would read an unlaid layout as a group that is already small.
 *
 * `index` counts the LEAVES from the left, exactly as in `withGroupShare` --
 * see the note there, which is the whole reason both of these are functions.
 */
export function groupShare(layout: EditorLayout, index: number): number | null {
  const family = familyOf(layout.groups, { index: assertIndex(index), seen: 0 }, layout.orientation);
  if (family === null) {
    return null;
  }
  const total = family.siblings.reduce((sum, node) => sum + (node.size ?? 0), 0);
  return total <= 0 ? null : (family.node.size ?? 0) / total;
}

/**
 * The layout with one group given `share` of the space it shares with its
 * siblings, or `null` when there is nothing sensible to ask the editor for.
 *
 * `index` is the group's place in the editor's own numbering minus one -- a
 * `ViewColumn` counts the LEAVES of this tree from the left, not the members of
 * the root's list, and the difference is the whole reason this is a function
 * rather than a line at the call site. Measured 2026-08-13: with two columns
 * open, a group made below the right-hand one arrives as the second child OF
 * THE SECOND CHILD, and column three names it. A rewrite that treated the
 * root's list as the columns would answer that layout by restacking the
 * person's two columns into rows -- their window rearranged for our
 * convenience, which is the one thing this must never do.
 *
 * So the change is pointwise: exactly one list of siblings is rebuilt, with the
 * total it had before, and every other node in the tree is passed back as it
 * came. The siblings share what is left in proportion to what they had, so a
 * neighbour that was bigger stays bigger.
 *
 * `null` means "ask the editor for nothing", and it is not a failure: a group
 * with no siblings already has the whole of its parent, and a parent whose
 * children have no size between them offers nothing to divide.
 */
export function withGroupShare(
  layout: EditorLayout,
  index: number,
  share: number
): EditorLayout | null {
  assertIndex(index);
  if (!(share > 0 && share < 1)) {
    throw new ValidationError('a share must be between zero and one, exclusive', {
      details: { share },
    });
  }

  const family = familyOf(layout.groups, { index, seen: 0 }, layout.orientation);
  if (family === null) {
    return null;
  }

  const total = family.siblings.reduce((sum, node) => sum + (node.size ?? 0), 0);
  const others = total - (family.node.size ?? 0);
  /*
   * The one guard, and it says all three of the ways there is nothing to ask
   * for: a group with no siblings holds the whole of its parent already, a
   * layout the editor has not sized yet has nothing to divide, and either way
   * the scaling below would divide by zero.
   *
   * Two more guards stood here first -- `total <= 0` and a count of the
   * siblings -- and both were taken out by the mutation bench, which could not
   * make either of them matter. A branch no input can reach before this one is
   * a promise made to nobody.
   */
  if (others <= 0) {
    return null;
  }

  const mine = Math.round(total * share);
  const scale = (total - mine) / others;
  const resized = family.siblings.map((node, at) => ({
    ...node,
    size: at === family.at ? mine : Math.round((node.size ?? 0) * scale),
  }));

  return { ...layout, groups: rebuilt(layout.groups, family.siblings, resized) };
}

/**
 * The list a leaf lives in, counting leaves left to right, and how that list is
 * laid out.
 *
 * `orientation` alternates on the way down -- the editor's own rule for this
 * shape, measured and written down at `COLUMNS`/`ROWS` above.
 */
function familyOf(
  siblings: readonly EditorLayoutNode[],
  state: { readonly index: number, seen: number },
  orientation: number
): Family | null {
  // `entries` and not an index: reading `siblings[at]` under
  // `noUncheckedIndexedAccess` would hand back an `undefined` that cannot
  // happen, and a guard for it is a branch no test can ever reach.
  for (const [at, node] of siblings.entries()) {
    if (node.groups === undefined) {
      if (state.seen === state.index) {
        return { siblings, at, node, orientation };
      }
      state.seen += 1;
    } else {
      const found = familyOf(node.groups, state, orientation === ROWS ? COLUMNS : ROWS);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/** The tree with one list swapped for another, by identity and nothing else. */
function rebuilt(
  nodes: readonly EditorLayoutNode[],
  target: readonly EditorLayoutNode[],
  next: readonly EditorLayoutNode[]
): readonly EditorLayoutNode[] {
  if (nodes === target) {
    return next;
  }
  return nodes.map((node) =>
    node.groups === undefined ? node : { ...node, groups: rebuilt(node.groups, target, next) }
  );
}

/** Both readers take the same index, so they refuse the same ones. */
function assertIndex(index: number): number {
  if (!Number.isInteger(index) || index < 0) {
    throw new ValidationError('the index of a group must be a non-negative integer', {
      details: { index },
    });
  }
  return index;
}
