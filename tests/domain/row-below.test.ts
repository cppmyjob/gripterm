import { rowBelowAtTheEnd } from '../../packages/core/src/index';

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
