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
  if (!Number.isInteger(index) || index < 0) {
    throw new ValidationError('the index of a group must be a non-negative integer', {
      details: { index },
    });
  }
  if (!(share > 0 && share < 1)) {
    throw new ValidationError('a share must be between zero and one, exclusive', {
      details: { share },
    });
  }

  const family = familyOf(layout.groups, { index, seen: 0 });
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

/** The list a leaf lives in, counting leaves left to right. */
function familyOf(
  siblings: readonly EditorLayoutNode[],
  state: { readonly index: number, seen: number }
): Family | null {
  // `entries` and not an index: reading `siblings[at]` under
  // `noUncheckedIndexedAccess` would hand back an `undefined` that cannot
  // happen, and a guard for it is a branch no test can ever reach.
  for (const [at, node] of siblings.entries()) {
    if (node.groups === undefined) {
      if (state.seen === state.index) {
        return { siblings, at, node };
      }
      state.seen += 1;
    } else {
      const found = familyOf(node.groups, state);
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
