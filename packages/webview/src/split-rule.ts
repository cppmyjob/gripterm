/**
 * Where the border between the two halves of the page may stand.
 *
 * A rule of its own rather than three lines inside a pointer handler, because
 * the thing it refuses is the defect class M3.9 names: `proposeDimensions()`
 * returns NaN for a box with no geometry (xterm.js#3029), a hidden panel is such
 * a box, and a layout computed from NaN reaches xterm as a resize to nothing.
 *
 * `null` is an answer and not a failure: it means "this box cannot hold both
 * halves, so leave the last good split where it is and do not fit". The caller
 * that ignores it gets a terminal of zero columns; the caller that honours it
 * gets the layout the person last chose, back again when the panel returns.
 */

export interface SplitBox {
  /** Everything the two halves and the divider have between them, in CSS pixels. */
  readonly total: number;
  readonly divider: number;
  /** What the terminal half is being asked to be -- the person's last drag. */
  readonly wanted: number;
  readonly minTerminal: number;
  readonly minDetails: number;
}

export interface Split {
  readonly terminal: number;
  readonly details: number;
}

export function resolveSplit(box: SplitBox): Split | null {
  const measures = [box.total, box.divider, box.wanted, box.minTerminal, box.minDetails];
  if (measures.some((measure) => !Number.isFinite(measure) || measure < 0)) {
    return null;
  }

  const usable = box.total - box.divider;
  if (usable <= 0) {
    return null;
  }

  // Fractions are kept rather than rounded away: the box arrives from
  // `getBoundingClientRect`, which has them, and a rounding here would show up
  // as a one-pixel seam that moves every time the panel is dragged.
  const most = usable - box.minDetails;
  if (most < box.minTerminal) {
    // The box is narrower than the two minima together -- measured, not
    // imagined: the panel in the test host is 299 px wide. Both halves are
    // squeezed and the ratio is kept, because a minimum is a preference about a
    // box that can hold it. The first version of this rule answered `null`
    // here, the stylesheet laid the halves out instead, and the terminal got
    // five pixels and two columns.
    const squeezed = Math.min(Math.max(box.wanted, 0), usable);
    return { terminal: squeezed, details: usable - squeezed };
  }

  const terminal = Math.min(Math.max(box.wanted, box.minTerminal), most);
  return { terminal, details: usable - terminal };
}
