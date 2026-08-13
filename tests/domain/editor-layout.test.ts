import { ValidationError, withGroupShare } from '../../packages/core/src/index';

/**
 * The numbers in this file are not invented. They are what a real VS Code
 * 1.133.0 answered `vscode.getEditorLayout` with on 2026-08-13, before and
 * after the rewrite this function computes -- so a change that stops matching
 * them is a change that stops matching the editor.
 */
describe('giving one editor group a share of its parent', () => {
  it('takes a third of a pair, and leaves the rest to the sibling', () => {
    // Measured: `newGroupBelow` splits the area evenly (371/372), and asking
    // the editor for 2:1 gave back exactly 495/248.
    expect(withGroupShare({ orientation: 1, groups: [{ size: 371 }, { size: 372 }] }, 1, 1 / 3)).toEqual(
      { orientation: 1, groups: [{ size: 495 }, { size: 248 }] }
    );
  });

  it('counts the groups the way the editor numbers its columns: leaves, left to right', () => {
    /*
     * The case that makes a naive implementation wrong. With two columns open,
     * a group below the right one is NESTED -- column three is the second child
     * of the second child, not the third member of the root. A rewrite that
     * treated the root's list as the columns would restack the person's two
     * columns into rows, which is their layout destroyed for our convenience.
     */
    expect(
      withGroupShare(
        {
          orientation: 0,
          groups: [{ size: 426 }, { size: 426, groups: [{ size: 371 }, { size: 372 }] }],
        },
        2,
        1 / 3
      )
    ).toEqual({
      orientation: 0,
      groups: [{ size: 426 }, { size: 426, groups: [{ size: 495 }, { size: 248 }] }],
    });
  });

  it('shares what is left in proportion, so a sibling that was bigger stays bigger', () => {
    expect(
      withGroupShare({ orientation: 1, groups: [{ size: 100 }, { size: 100 }, { size: 400 }] }, 2, 1 / 3)
    ).toEqual({ orientation: 1, groups: [{ size: 200 }, { size: 200 }, { size: 200 }] });
  });

  it('keeps the parent the size it was, so nothing else on the screen moves', () => {
    const layout = withGroupShare(
      { orientation: 1, groups: [{ size: 371 }, { size: 372 }] },
      1,
      1 / 3
    );

    expect(layout?.groups.reduce((sum, node) => sum + (node.size ?? 0), 0)).toBe(743);
  });

  it('leaves the layout it was given alone', () => {
    // The editor's answer is passed straight back to the editor, so a mutation
    // here would be a rewrite nobody asked for arriving through the back door.
    const given = { orientation: 1, groups: [{ size: 371 }, { size: 372 }] };

    withGroupShare(given, 1, 1 / 3);

    expect(given).toEqual({ orientation: 1, groups: [{ size: 371 }, { size: 372 }] });
  });

  it('asks for nothing when the group is alone, because a share of one is the whole', () => {
    expect(withGroupShare({ orientation: 1, groups: [{ size: 743 }] }, 0, 1 / 3)).toBeNull();
  });

  it('asks for nothing when no such group is on the screen', () => {
    expect(withGroupShare({ orientation: 1, groups: [{ size: 371 }, { size: 372 }] }, 5, 1 / 3)).toBeNull();
  });

  it('asks for nothing when the sizes add up to nothing, rather than dividing by zero', () => {
    expect(withGroupShare({ orientation: 1, groups: [{ size: 0 }, { size: 0 }] }, 1, 1 / 3)).toBeNull();
  });

  it('asks for nothing when the siblings have no size to give', () => {
    // The target holds the whole of the parent. Scaling the others would be a
    // division by zero, and there is nothing sensible to scale anyway.
    expect(withGroupShare({ orientation: 1, groups: [{ size: 0 }, { size: 743 }] }, 1, 1 / 3)).toBeNull();
  });

  it('asks for nothing when the editor has not sized the groups at all', () => {
    // `size` is optional in the editor's own answer, and a layout it has not
    // laid out yet says nothing about proportions -- so neither do we.
    expect(withGroupShare({ orientation: 1, groups: [{}, {}] }, 1, 1 / 3)).toBeNull();
  });

  it('counts a group the editor has not sized yet as nothing, rather than refusing the lot', () => {
    expect(
      withGroupShare({ orientation: 1, groups: [{}, { size: 300 }, { size: 300 }] }, 1, 1 / 3)
    ).toEqual({ orientation: 1, groups: [{ size: 0 }, { size: 200 }, { size: 400 }] });
  });

  it('says the same thing twice, so a second window opening a terminal moves nothing', () => {
    const once = withGroupShare({ orientation: 1, groups: [{ size: 371 }, { size: 372 }] }, 1, 1 / 3);

    expect(withGroupShare(once ?? { orientation: 1, groups: [] }, 1, 1 / 3)).toEqual(once);
  });

  it('refuses a share that is not a share', () => {
    const layout = { orientation: 1, groups: [{ size: 371 }, { size: 372 }] };

    expect(() => withGroupShare(layout, 1, 0)).toThrow(ValidationError);
    expect(() => withGroupShare(layout, 1, 1)).toThrow(ValidationError);
    expect(() => withGroupShare(layout, 1, -0.5)).toThrow(ValidationError);
    expect(() => withGroupShare(layout, 1, Number.NaN)).toThrow(ValidationError);
  });

  it('refuses an index that is not a column', () => {
    const layout = { orientation: 1, groups: [{ size: 371 }, { size: 372 }] };

    expect(() => withGroupShare(layout, -1, 1 / 3)).toThrow(ValidationError);
    expect(() => withGroupShare(layout, 1.5, 1 / 3)).toThrow(ValidationError);
  });
});
