import { RESIZES, whatTheSizesDid } from './integration/what-the-sizes-did';
import type { SizesSeen } from './integration/what-the-sizes-did';

/**
 * The one line `terminal-in-view` says about resizing, on every run of it.
 *
 * **What this is for.** The numbers in it existed already, and only a FAILING
 * run had them: they were built inside the `catch` of the wait for ConPTY's
 * acknowledgement. So the only way to collect a sample was to wait for red --
 * `live` went red 7 times in 26 full gates on 2026-08-26, which is a sample of
 * seven over three days for a question about milliseconds. Said on every run,
 * a green gate is a measurement too, and the same sample arrives an order of
 * magnitude sooner.
 *
 * **One line, and one per run of the suite rather than per attempt.** The wait
 * polls every 25 ms for up to thirty seconds; a line per look would be twelve
 * hundred lines of the gate's output for a fact that has one value. What the
 * line holds is what the timeline already held -- one entry per size the bridge
 * actually let through, which is at most a handful.
 *
 * **It promises nothing about the product.** The cause of the red resize is not
 * known and this does not claim to know it. This is an instrument.
 */

const SEEN: SizesSeen = {
  sent: 2,
  moments: ['+2ms #1 {"cols":25,"rows":13}', '+112ms #2 {"cols":46,"rows":12}'],
  acknowledgedAfterMs: 143,
  waitedMs: 143,
  settled: { cols: 46, rows: 12 },
  spawned: { cols: 80, rows: 30 },
};

describe('what the sizes did, said on every run', () => {
  it('says how long the pseudoconsole took to acknowledge one', () => {
    expect(whatTheSizesDid(SEEN)).toContain('the pseudoconsole acknowledged one after 143 ms');
  });

  it('says that it acknowledged nothing, and for how long, when it did not', () => {
    const said = whatTheSizesDid({ ...SEEN, acknowledgedAfterMs: null, waitedMs: 30_000 });

    expect(said).toContain('the pseudoconsole acknowledged nothing in 30000 ms');
  });

  it('keeps every number the failing run already said, word for word', () => {
    // The wording is not decoration: this exact substring is what the failure
    // message of `terminal-in-view` has carried since 2026-08-21, and it is
    // quoted in the plan and in this suite's own comments. Adding to it is
    // free; rewording it would silently orphan every record that quotes it.
    expect(whatTheSizesDid(SEEN)).toContain(
      'the bridge sent 2 sizes [+2ms #1 {"cols":25,"rows":13}, +112ms #2 {"cols":46,"rows":12}], ' +
      'the page settled at 46x12, the pty was spawned at 80x30'
    );
  });

  it('carries one word a grep can find it by, across every log a gate leaves', () => {
    expect(whatTheSizesDid(SEEN).startsWith(`${RESIZES}:`)).toBe(true);
  });

  it('is one line, because it is said on a green run as well as a red one', () => {
    const said = whatTheSizesDid({ ...SEEN, acknowledgedAfterMs: null, waitedMs: 30_000 });

    expect(said).not.toContain('\n');
    expect(said).not.toContain('\r');
  });

  it('says a run where the bridge sent nothing at all, rather than saying nothing', () => {
    const said = whatTheSizesDid({ ...SEEN, sent: 0, moments: [], acknowledgedAfterMs: null, waitedMs: 30_000 });

    expect(said).toContain('the bridge sent 0 sizes []');
  });
});
