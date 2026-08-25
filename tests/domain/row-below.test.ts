import { amongRows, columnsIn, rowBelowAtTheEnd } from '../../packages/core/src/index';

/**
 * Which end of the editor area is "the end".
 *
 * Every layout here was answered by a real editor and is written down beside
 * the case it came from. The one that matters most is the two-column window:
 * the customer sent a screenshot of it on 2026-08-22, their terminal full
 * height on the left and a file on the right, with the log line
 * `the terminals went into the empty group at the end of the editor area
 * {"column":2}` underneath. The end of a window laid out in columns is the
 * right-hand COLUMN, and a strip is never that.
 */
describe('the row at the bottom of the editor area', () => {
  it('finds the bottom row of a window split into two rows', () => {
    // Measured: `newGroupBelow` over one group, then a third asked for.
    expect(rowBelowAtTheEnd({ orientation: 1, groups: [{ size: 495 }, { size: 248 }] })).toBe(1);
  });

  it('refuses the right-hand column of a window split into two columns', () => {
    // The customer's window. `[1] terminal | [2] file`, measured at 426/426.
    expect(rowBelowAtTheEnd({ orientation: 0, groups: [{ size: 426 }, { size: 426 }] })).toBeNull();
  });

  it('finds a strip made under one column of two, which is where a strip belongs', () => {
    /*
     * Measured 2026-08-13: with two columns open, a group made below the right
     * one arrives as the second child OF THE SECOND CHILD, and column three
     * names it. Nested levels alternate, so that inner pair is rows.
     */
    expect(
      rowBelowAtTheEnd({
        orientation: 0,
        groups: [{ size: 426 }, { size: 426, groups: [{ size: 495 }, { size: 248 }] }],
      })
    ).toBe(2);
  });

  it('refuses a column made beside one row of two', () => {
    // The mirror of the case above, and the one that must not be adopted: the
    // inner pair is columns, so its last leaf is a column beside a column.
    expect(
      rowBelowAtTheEnd({
        orientation: 1,
        groups: [{ size: 371 }, { size: 372, groups: [{ size: 426 }, { size: 426 }] }],
      })
    ).toBeNull();
  });

  it('refuses an editor area holding one group, however it is oriented', () => {
    // How every window starts. There is nothing above it, so it is not a strip.
    expect(rowBelowAtTheEnd({ orientation: 1, groups: [{ size: 743 }] })).toBeNull();
    expect(rowBelowAtTheEnd({ orientation: 0, groups: [{ size: 743 }] })).toBeNull();
  });

  it('refuses a layout with nothing in it', () => {
    expect(rowBelowAtTheEnd({ orientation: 1, groups: [] })).toBeNull();
  });

  it('counts the leaves before it the way the editor numbers its columns', () => {
    // Three columns, the last of which is split into rows: the bottom row is
    // column four, so index three.
    expect(
      rowBelowAtTheEnd({
        orientation: 0,
        groups: [{ size: 200 }, { size: 200 }, { size: 343, groups: [{ size: 495 }, { size: 248 }] }],
      })
    ).toBe(3);
  });
});

/**
 * How many COLUMNS the editor area has, which is not how many tab groups the
 * editor will list.
 *
 * **The measurement this exists for, 2026-08-25, over nine runs of the stand.**
 * `vscode.window.tabGroups.all` in Cursor lists groups the editor's own grid
 * does not hold: a "New Agent" editor lives in a part of its own, is restored
 * with the window, and answers with a `viewColumn` one past the last real
 * column. The stand prints the disagreement on every run that has one -- "the
 * grid accounted for 2, 2, 1, 1 of them, which is the editor holding a tab
 * group outside its own grid" -- and it is not a curiosity: a rule that counts
 * `tabGroups.all` to decide whether the strip still has a neighbour counts that
 * one, closes the real neighbour, and leaves the strip alone in the area with
 * point 3 of the stand red about it.
 *
 * So the number of columns comes from the GRID, which is the editor's own
 * answer about its own area, and nothing infers it from a list of tabs.
 */
describe('how many columns the editor area has', () => {
  it('counts one for a window with one group', () => {
    expect(columnsIn({ orientation: 1, groups: [{ size: 743 }] })).toBe(1);
  });

  it('counts the leaves and not the members of the root list', () => {
    // Measured 2026-08-13: two columns with a strip below the right-hand one.
    // The root holds two children and the area holds three columns.
    expect(
      columnsIn({
        orientation: 0,
        groups: [{ size: 426 }, { size: 426, groups: [{ size: 495 }, { size: 248 }] }],
      })
    ).toBe(3);
  });

  it('counts nothing for a layout with no groups in it at all', () => {
    // Not a shape any editor has answered with; it is here because `null` and
    // nought are different answers everywhere else in this file, and this one
    // is a count, where nought is the honest number.
    expect(columnsIn({ orientation: 1, groups: [] })).toBe(0);
  });
});

/**
 * Whether a group of the editor area is a ROW among rows -- which is the same
 * question `rowBelowAtTheEnd` asks about the last leaf, asked about any leaf.
 *
 * **The measurement it exists for, 2026-08-25.** `VsCodeEditorStrip` refuses to
 * adopt an empty group that sits BESIDE the editors ("the empty group at the
 * end of the editor area is beside the editors, not below them") and then, in
 * the same turn, its sweep of leftovers closed that very group -- the person's
 * own empty column, gone the moment they opened a terminal. Refusing to take a
 * group and then taking it away is one rule contradicting itself, and the half
 * that was missing is this one: a leftover of OURS is a row, because a strip is
 * only ever made as a row below the editors.
 *
 * A family of ONE is not "among" anything and answers `false`, for the reason
 * `rowBelowAtTheEnd` gives about the same shape: an editor area holding one
 * group is nobody's strip, however it is oriented.
 */
describe('whether a group sits among rows', () => {
  it('says so for a strip under the editors, and for the editors above it', () => {
    // Measured 2026-08-22 in Cursor: a strip made below a file.
    const rows = { orientation: 1, groups: [{ size: 317 }, { size: 159 }] };
    expect(amongRows(rows, 0)).toBe(true);
    expect(amongRows(rows, 1)).toBe(true);
  });

  it('says no for a column standing beside the editors', () => {
    // The customer's window of 2026-08-22, and the stand of the test that
    // caught the sweep taking it: two columns, one of them empty.
    expect(amongRows({ orientation: 0, groups: [{ size: 426 }, { size: 426 }] }, 1)).toBe(false);
  });

  it('asks about the family the leaf is in, not about the root', () => {
    /*
     * Measured 2026-08-13: two columns with a strip below the right-hand one.
     * The left column is a column among columns and the strip is a row among
     * rows, in one and the same layout -- which is the whole reason this is a
     * question about a leaf rather than about the window.
     */
    const nested = {
      orientation: 0,
      groups: [{ size: 426 }, { size: 426, groups: [{ size: 495 }, { size: 248 }] }],
    };
    expect(amongRows(nested, 0)).toBe(false);
    expect(amongRows(nested, 1)).toBe(true);
    expect(amongRows(nested, 2)).toBe(true);
  });

  it('says no for the only group of the editor area, whatever the orientation says', () => {
    expect(amongRows({ orientation: 1, groups: [{ size: 743 }] }, 0)).toBe(false);
  });

  it('answers nothing at all about a leaf that is not there', () => {
    // `null` and not `false`: "there is no such group" and "that group is not a
    // row" are different answers, and the caller closes editor groups on them.
    expect(amongRows({ orientation: 1, groups: [{ size: 317 }, { size: 159 }] }, 2)).toBeNull();
  });
});
