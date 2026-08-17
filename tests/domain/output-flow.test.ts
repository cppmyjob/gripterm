import { OutputFlow, PAUSE_ABOVE_CHARS, RESUME_NOT_ABOVE_CHARS } from '../../packages/core/src/index';

/**
 * The rule that decides when an agent is told to stop talking -- and, far more
 * importantly, when it is told it may go on.
 *
 * This is the one rule of M3.7 whose failure is not a wrong pixel but a dead
 * agent: `pause()` on a pty with no `resume()` after it leaves `claude` blocked
 * on a full ConPTY buffer forever, and nothing on the screen says so. That is an
 * irreversible act in the sense of §I.3, which is why the decision lives here --
 * a total function of two counters, with no editor, no timer and no webview in
 * it -- and why the negative cases below outnumber the positive ones.
 *
 * The numbers come from a measurement rather than from taste (M3.2 stage B, §6):
 * without any pause, the consumer fell 560 928 characters behind on a stream of
 * 1.84 million; a receipt comes back in 17-30 ms; a burst produces ~1.5 million
 * characters a second. So the pause line has to be two orders below the measured
 * peak, and it has to stay above what a HEALTHY consumer has in flight at a
 * burst (30 ms x 1.5 M/s ~ 45 000) -- otherwise back-pressure would throttle the
 * case it exists to protect. Owner's decision of 2026-08-17: 50 000 and 5 000.
 */

describe('the thresholds this build pauses at', () => {
  it('are the numbers the owner chose, in code units rather than bytes', () => {
    // In UTF-16 code units, deliberately: this project promises emoji and CJK,
    // and a threshold counted in bytes would mean something different for each.
    expect(PAUSE_ABOVE_CHARS).toBe(50_000);
    expect(RESUME_NOT_ABOVE_CHARS).toBe(5_000);
  });
});

describe('a flow nobody is falling behind on', () => {
  it('starts quiet, with nothing in flight', () => {
    const flow = new OutputFlow();

    expect(flow.paused).toBe(false);
    expect(flow.unacknowledged).toBe(0);
  });

  it('moves nothing while the consumer keeps up', () => {
    const flow = new OutputFlow();

    expect(flow.sent(10_000)).toBeNull();
    expect(flow.acknowledged(10_000)).toBeNull();
    expect(flow.paused).toBe(false);
    expect(flow.unacknowledged).toBe(0);
  });

  it('does not pause AT the line, only above it', () => {
    // Strictly above, because the line itself is a size we chose to allow: a
    // rule that paused at it would pause on a stream that is exactly within
    // what we said we would carry.
    const flow = new OutputFlow();

    expect(flow.sent(PAUSE_ABOVE_CHARS)).toBeNull();
    expect(flow.paused).toBe(false);
  });
});

describe('a consumer that is falling behind', () => {
  it('is paused once it is past the line, and told exactly once', () => {
    const flow = new OutputFlow();

    expect(flow.sent(PAUSE_ABOVE_CHARS + 1)).toBe('pause');
    expect(flow.paused).toBe(true);
    // The second send must NOT say 'pause' again: the caller turns this answer
    // into a call on a pty, and a pty told to pause twice is a pty resumed once
    // too few if anybody ever counts.
    expect(flow.sent(1000)).toBeNull();
  });

  it('is not let go while it is still far behind', () => {
    const flow = new OutputFlow();
    flow.sent(PAUSE_ABOVE_CHARS + 1000);

    expect(flow.acknowledged(1000)).toBeNull();
    expect(flow.paused).toBe(true);
  });

  it('is let go at the resume line, and told exactly once', () => {
    const flow = new OutputFlow();
    flow.sent(PAUSE_ABOVE_CHARS + 1);
    // Down to exactly the resume line: `<=`, not `<`, and that is the whole
    // reason the constant is named for the comparison. A rule that waited for
    // strictly less would hold a pause forever on a consumer whose last receipt
    // landed on the number itself.
    const left = PAUSE_ABOVE_CHARS + 1 - RESUME_NOT_ABOVE_CHARS;

    expect(flow.acknowledged(left)).toBe('resume');
    expect(flow.paused).toBe(false);
    expect(flow.acknowledged(1)).toBeNull();
  });

  it('can be paused again after it was let go', () => {
    const flow = new OutputFlow();
    flow.sent(PAUSE_ABOVE_CHARS + 1);
    flow.acknowledged(PAUSE_ABOVE_CHARS + 1);

    expect(flow.paused).toBe(false);
    expect(flow.sent(PAUSE_ABOVE_CHARS + 1)).toBe('pause');
  });
});

describe('a consumer that stopped being there', () => {
  /*
   * The half of this rule that the plan spells out and the reason the whole
   * class exists. A hidden webview keeps its page under
   * `retainContextWhenHidden`, but Chromium clamps a hidden frame's timers and
   * xterm schedules its writes through `setTimeout` -- so the receipts simply
   * stop. A rule that waited for them would hold the pause forever on a
   * consumer that is formally alive, and the agent behind it would sit against
   * a full buffer until somebody pressed Ctrl+J.
   */
  it('is let go unconditionally, and its debt is forgotten', () => {
    const flow = new OutputFlow();
    flow.sent(PAUSE_ABOVE_CHARS + 1);

    expect(flow.left()).toBe('resume');
    expect(flow.paused).toBe(false);
    expect(flow.unacknowledged).toBe(0);
  });

  it('moves nothing when it was not holding anything up', () => {
    const flow = new OutputFlow();
    flow.sent(100);

    expect(flow.left()).toBeNull();
    expect(flow.unacknowledged).toBe(0);
  });

  it('does not go into credit when a late receipt arrives after it left', () => {
    // Receipts posted before the panel was hidden can arrive after it: the
    // channel keeps them. A counter that went negative would then need a whole
    // extra window of output before the next pause -- which is the same defect
    // as no pause at all, arriving later.
    const flow = new OutputFlow();
    flow.sent(10_000);
    flow.left();

    expect(flow.acknowledged(10_000)).toBeNull();
    expect(flow.unacknowledged).toBe(0);
  });
});

describe('what the flow refuses to count', () => {
  it.each([
    ['nothing that is a number', Number.NaN],
    ['an infinity', Number.POSITIVE_INFINITY],
    ['a negative amount', -1],
    ['a fraction of a code unit', 1.5],
  ])('refuses to be sent %s', (_what, chars) => {
    const flow = new OutputFlow();

    expect(() => flow.sent(chars)).toThrow(/whole, positive count/u);
  });

  it.each([
    ['nothing that is a number', Number.NaN],
    ['a negative amount', -1],
    ['a fraction of a code unit', 0.5],
  ])('refuses a receipt for %s', (_what, chars) => {
    const flow = new OutputFlow();

    expect(() => flow.acknowledged(chars)).toThrow(/whole, positive count/u);
  });

  it('refuses a resume line that is not below the pause line', () => {
    // The two would then be one, and every receipt would flip the pty between
    // paused and running -- a flap that produces no throughput and a great many
    // native calls.
    expect(() => new OutputFlow({ pauseAboveChars: 100, resumeNotAboveChars: 100 })).toThrow(
      /below the line it pauses at/u
    );
  });

  it('refuses lines that are not counts at all', () => {
    expect(() => new OutputFlow({ pauseAboveChars: -1, resumeNotAboveChars: 0 })).toThrow(
      /whole, positive count/u
    );
    expect(() => new OutputFlow({ pauseAboveChars: 100, resumeNotAboveChars: Number.NaN })).toThrow(
      /whole, positive count/u
    );
  });
});
