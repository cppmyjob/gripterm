import { insertionIndex } from '../../packages/webview/src/drop-rule';

/**
 * Where a dragged tab lands, in the only units the strip and the store agree on:
 * the index it will have in the list AFTER the move.
 *
 * A rule with a test rather than three lines inside a drag handler, for the
 * reason `split-rule.ts` is one too: the arithmetic is off-by-one in both
 * directions and the failure is silent -- a tab that lands one place from where
 * the person let go looks like a person who dropped it badly.
 */
describe('where a dragged tab lands', () => {
  it('drops before the tab it was let go on, when let go on its left half', () => {
    // Four tabs, dragging the first one onto the left of the third: it goes
    // between the second and the third, which is index 1 once it is out of the
    // list and put back in.
    expect(insertionIndex({ from: 0, over: 2, afterMidpoint: false })).toBe(1);
  });

  it('drops after the tab it was let go on, when let go on its right half', () => {
    expect(insertionIndex({ from: 0, over: 2, afterMidpoint: true })).toBe(2);
  });

  it('counts the same way when the tab is dragged backwards', () => {
    // Dragging the last tab onto the left of the first: it becomes the first.
    expect(insertionIndex({ from: 3, over: 0, afterMidpoint: false })).toBe(0);
    // And onto its right half: second.
    expect(insertionIndex({ from: 3, over: 0, afterMidpoint: true })).toBe(1);
  });

  it('answers with the place it already has when it is let go on itself', () => {
    // Both halves, because a person letting go on the tab they picked up has
    // changed nothing and must not be told they moved it somewhere.
    expect(insertionIndex({ from: 1, over: 1, afterMidpoint: false })).toBe(1);
    expect(insertionIndex({ from: 1, over: 1, afterMidpoint: true })).toBe(1);
  });

  it('never answers with a negative place', () => {
    expect(insertionIndex({ from: 0, over: 0, afterMidpoint: false })).toBe(0);
  });
});
