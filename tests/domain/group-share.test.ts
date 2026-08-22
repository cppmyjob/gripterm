import { ValidationError, groupShare } from '../../packages/core/src/index';

/**
 * Reading back what the editor did with a layout we asked it for.
 *
 * The numbers are measured, like the ones next door in `editor-layout.test.ts`.
 * The pair 70/673 is Cursor 1.128.0 on 2026-08-22: the customer pressed the
 * plus with the list focused in a window that had only just started, and the
 * strip came out holding 673 pixels of the 743 the editor area had -- "терминал
 * на всю область файлов". Nothing had gone wrong that any answer said out loud:
 * `withGroupShare` was handed a layout the editor had not sized yet, answered
 * `null` as it should, and the caller had no way to tell that from success.
 */
describe('what share of its parent an editor group holds', () => {
  it('reads the share of a pair the editor has laid out', () => {
    expect(groupShare({ orientation: 1, groups: [{ size: 495 }, { size: 248 }] }, 1)).toBeCloseTo(1 / 3, 3);
  });

  it('reads the strip that took the whole editor area, which is the defect', () => {
    expect(groupShare({ orientation: 1, groups: [{ size: 70 }, { size: 673 }] }, 1)).toBeCloseTo(0.906, 3);
  });

  it('counts the leaves the way the editor numbers its columns', () => {
    // Column three of a window in two columns is the second child of the second
    // child -- the case that makes a naive reading wrong, and the same tree
    // `withGroupShare` is tested on.
    const layout = {
      orientation: 0,
      groups: [{ size: 426 }, { size: 426, groups: [{ size: 371 }, { size: 372 }] }],
    };

    expect(groupShare(layout, 2)).toBeCloseTo(372 / 743, 3);
    expect(groupShare(layout, 0)).toBeCloseTo(0.5, 3);
  });

  it('says nothing rather than zero about a layout the editor has not sized', () => {
    // The measured case: `getEditorLayout` right after a split. A share of zero
    // here would read "not laid out yet" as "already small enough" and leave
    // the strip holding whatever the split gave it.
    expect(groupShare({ orientation: 1, groups: [{}, {}] }, 1)).toBeNull();
    expect(groupShare({ orientation: 1, groups: [{ size: 0 }, { size: 0 }] }, 1)).toBeNull();
  });

  it('says nothing about a column that is not there', () => {
    expect(groupShare({ orientation: 1, groups: [{ size: 371 }, { size: 372 }] }, 5)).toBeNull();
  });

  it('refuses an index that is not a column', () => {
    const layout = { orientation: 1, groups: [{ size: 371 }, { size: 372 }] };

    expect(() => groupShare(layout, -1)).toThrow(ValidationError);
    expect(() => groupShare(layout, 1.5)).toThrow(ValidationError);
  });
});
