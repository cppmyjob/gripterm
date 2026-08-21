/**
 * Where a dragged tab lands.
 *
 * A rule of its own, next to `split-rule.ts` and for the same reason: the
 * arithmetic is off by one in both directions, and getting it wrong is silent.
 * A tab that lands one place away from where somebody let go of it reads as a
 * clumsy hand rather than as a defect, so it would be lived with rather than
 * reported.
 *
 * The answer is in the units the store speaks: the index the tab will have in
 * the list AFTER the move, counting itself. That is what `reorderTerminals`
 * takes, so nothing between the mouse and the record has to convert anything.
 */

export interface DropRequest {
  /** Where the dragged tab stands now, from 0. */
  readonly from: number;
  /** The tab it was let go on, from 0. */
  readonly over: number;
  /** Whether it was let go on the right half of that tab, rather than the left. */
  readonly afterMidpoint: boolean;
}

export function insertionIndex(request: DropRequest): number {
  const { from, over, afterMidpoint } = request;
  if (over === from) {
    // Let go on the tab that was picked up. Which half of it the pointer was
    // over says nothing: the person moved nothing, and answering `from + 1`
    // would shuffle the strip under somebody who thought better of it.
    return from;
  }
  // Where the tab it was let go on stands once the dragged one is taken out of
  // the list: everything after the hole moves up by one.
  const withoutMoved = over > from ? over - 1 : over;
  const landed = afterMidpoint ? withoutMoved + 1 : withoutMoved;
  return Math.max(landed, 0);
}
