import { resolveSplit } from '../../packages/webview/src/split-rule';

/**
 * Where the border between the two halves may stand.
 *
 * A pure rule rather than three lines inside a pointer handler, for the reason
 * M3.9 states about the same class of defect: `FitAddon.proposeDimensions()`
 * returns NaN on a box with no geometry (xterm.js#3029), and a layout computed
 * from NaN reaches xterm as a resize to nothing. The rule answers `null` for
 * every box it cannot lay out, and `null` means "leave the last good split
 * alone and do not fit" -- which is a decision, and therefore has tests.
 */

const MINIMA = { minTerminal: 240, minDetails: 180, divider: 4 };

describe('where the border stands', () => {
  it('gives the terminal what was asked when the box can hold it', () => {
    expect(resolveSplit({ ...MINIMA, total: 1000, wanted: 700 })).toEqual({
      terminal: 700,
      details: 296,
    });
  });

  it('never lets the details half fall below its minimum', () => {
    expect(resolveSplit({ ...MINIMA, total: 1000, wanted: 990 })).toEqual({
      terminal: 816,
      details: 180,
    });
  });

  it('never lets the terminal fall below its own', () => {
    expect(resolveSplit({ ...MINIMA, total: 1000, wanted: 10 })).toEqual({
      terminal: 240,
      details: 756,
    });
  });

  it('keeps fractions rather than rounding them away, because the box has them', () => {
    expect(resolveSplit({ ...MINIMA, total: 1000.5, wanted: 700.25 })).toEqual({
      terminal: 700.25,
      details: 296.25,
    });
  });

  it('squeezes both halves when the box cannot hold their minima, instead of refusing', () => {
    // 240 + 180 + 4 is 424, and this is one pixel short of it. Measured
    // 2026-08-17 in the test host: the panel there is 299 px wide, which is
    // narrower than the two minima together -- and the first version of this
    // rule answered `null` for it, left the halves to the stylesheet, and gave
    // the terminal FIVE pixels and two columns. A minimum is a preference about
    // a box that can hold it; it is not a reason to stop laying out.
    expect(resolveSplit({ ...MINIMA, total: 423, wanted: 300 })).toEqual({
      terminal: 300,
      details: 119,
    });
  });

  it('keeps the ratio when it squeezes, so the person still sees both halves', () => {
    expect(resolveSplit({ ...MINIMA, total: 300, wanted: 207 })).toEqual({
      terminal: 207,
      details: 89,
    });
  });

  it('gives the whole squeezed box to the terminal when that is what was asked', () => {
    expect(resolveSplit({ ...MINIMA, total: 300, wanted: 5000 })).toEqual({
      terminal: 296,
      details: 0,
    });
  });

  it('lays out the exact box that fits both minima', () => {
    expect(resolveSplit({ ...MINIMA, total: 424, wanted: 300 })).toEqual({
      terminal: 240,
      details: 180,
    });
  });

  it.each([
    ['a hidden box, which is the trap this rule exists for', { total: 0, wanted: 700 }],
    ['a box narrower than its own divider', { total: 4, wanted: 2 }],
    ['a box of NaN', { total: Number.NaN, wanted: 700 }],
    ['a wanted width of NaN', { total: 1000, wanted: Number.NaN }],
    ['an infinite box', { total: Number.POSITIVE_INFINITY, wanted: 700 }],
    ['a negative box', { total: -1000, wanted: 700 }],
    ['a negative wish', { total: 1000, wanted: -50 }],
  ])('refuses %s', (_what, box) => {
    expect(resolveSplit({ ...MINIMA, ...box })).toBeNull();
  });

  it.each([
    ['a divider of NaN', { divider: Number.NaN }],
    ['a negative divider', { divider: -4 }],
    ['a minimum of NaN', { minTerminal: Number.NaN }],
    ['a negative minimum', { minDetails: -180 }],
  ])('refuses %s', (_what, broken) => {
    expect(resolveSplit({ ...MINIMA, ...broken, total: 1000, wanted: 700 })).toBeNull();
  });
});
