import { QuietSpell, ValidationError } from '../../packages/core/src/index';
import { FakeScheduler, type ArmedTimer } from '../helpers/port-fakes';

/**
 * "The workbench has finished" said as something that can be observed, and with
 * a ceiling on it.
 *
 * The rule the plan asks for is "no events for N ms", and half of that rule is
 * the half people forget: a window that never woke up also has no events, and a
 * wait with no ceiling on it is a wait that becomes a hang. So a burst ends the
 * moment it goes quiet OR the moment it has gone on too long, and WHICH of the
 * two is the answer -- a reader of the log must be able to tell a window that
 * settled from a window that was given up on.
 *
 * What this replaces in `VsCodeEditorStrip`: six looks half a second apart and
 * then one more half-second pause -- three and a half seconds of sleeping
 * whatever the window was doing, which is a bet on a number rather than a wait
 * for something. The number was measured to be wrong in both directions on the
 * stand of 2026-08-25: the grid was back in 1.3 s (so three seconds of it were
 * spent doing nothing) and the sweep that followed then found a strip already
 * made and left every leftover group where it was.
 */
describe('a spell of quiet, with a ceiling', () => {
  const QUIET_MS = 1000;
  const CEILING_MS = 5000;

  interface Stand {
    readonly scheduler: FakeScheduler;
    readonly ends: string[];
    readonly spell: QuietSpell;
  }

  function stand(): Stand {
    const scheduler = new FakeScheduler();
    const ends: string[] = [];
    const spell = new QuietSpell({
      quietMs: QUIET_MS,
      ceilingMs: CEILING_MS,
      scheduler,
      onQuiet: (why) => {
        ends.push(why);
      },
    });
    return { scheduler, ends, spell };
  }

  /**
   * Lets one named wait expire.
   *
   * By its length and not by its place in the list: two waits are armed at once
   * here and which of them is first is an implementation detail this file has
   * no business asserting.
   */
  function fire(scheduler: FakeScheduler, ms: number): void {
    const timer: ArmedTimer | undefined = scheduler.live.find((one) => one.ms === ms);
    if (timer === undefined) {
      throw new Error(`nothing was waiting for ${String(ms)} ms`);
    }
    timer.cancelled = true;
    timer.action();
  }

  it('answers when nothing has stirred for the quiet time', () => {
    const { scheduler, ends, spell } = stand();

    spell.stir();
    expect(ends).toEqual([]);

    fire(scheduler, QUIET_MS);
    expect(ends).toEqual(['the window went quiet']);
    // And the ceiling of that burst is taken down with it, rather than left to
    // fire into a burst that is over.
    expect(scheduler.live).toEqual([]);
  });

  it('starts the quiet time again on every stir', () => {
    const { scheduler, ends, spell } = stand();

    spell.stir();
    spell.stir();
    spell.stir();

    // Three stirs, three waits armed and two of them cancelled: the last one is
    // the only one that can answer.
    expect(scheduler.live.filter((one) => one.ms === QUIET_MS)).toHaveLength(1);
    fire(scheduler, QUIET_MS);
    expect(ends).toEqual(['the window went quiet']);
  });

  it('ends a burst that never goes quiet, and says that is what happened', () => {
    const { scheduler, ends, spell } = stand();

    spell.stir();
    // A window that keeps moving: the quiet wait is pushed back for ever and
    // only the ceiling can end this.
    spell.stir();
    spell.stir();

    fire(scheduler, CEILING_MS);
    expect(ends).toEqual(['the ceiling was reached']);
    expect(scheduler.live).toEqual([]);
  });

  it('does not move the ceiling of a burst that is already running', () => {
    const { scheduler, spell } = stand();

    spell.stir();
    spell.stir();
    spell.stir();

    // One ceiling for the burst, armed when it began. A ceiling rearmed on
    // every stir is not a ceiling.
    expect(scheduler.live.filter((one) => one.ms === CEILING_MS)).toHaveLength(1);
  });

  it('starts a fresh burst, with a fresh ceiling, after one has ended', () => {
    const { scheduler, ends, spell } = stand();

    spell.stir();
    fire(scheduler, QUIET_MS);
    expect(ends).toEqual(['the window went quiet']);

    spell.stir();
    expect(scheduler.live.filter((one) => one.ms === CEILING_MS)).toHaveLength(1);
    fire(scheduler, CEILING_MS);
    expect(ends).toEqual(['the window went quiet', 'the ceiling was reached']);
  });

  it('answers a caller that is waiting for the window to stop', async () => {
    const { scheduler, spell } = stand();

    // Nothing is stirring, and this must not be a wait with no end: asking to
    // be told when the window stops starts a burst of its own.
    const waited = spell.whenQuiet();
    fire(scheduler, QUIET_MS);

    expect(await waited).toBe('the window went quiet');
  });

  it('answers a caller waiting on a burst that was already running', async () => {
    const { scheduler, spell } = stand();

    spell.stir();
    const waited = spell.whenQuiet();
    fire(scheduler, CEILING_MS);

    expect(await waited).toBe('the ceiling was reached');
  });

  it('lets go of whoever is waiting when it is disposed of', async () => {
    const { scheduler, ends, spell } = stand();

    spell.stir();
    const waited = spell.whenQuiet();
    spell.dispose();

    // A window being torn down must not leave a turn waiting for an event that
    // is never coming, and the waits it armed go with it.
    expect(await waited).toBe('nothing is watching the window any more');
    expect(scheduler.live).toEqual([]);
    expect(ends).toEqual([]);
  });

  it('refuses a ceiling that is not longer than the quiet it is over', () => {
    expect(
      () =>
        new QuietSpell({
          quietMs: 1000,
          ceilingMs: 1000,
          scheduler: new FakeScheduler(),
          onQuiet: () => undefined,
        })
    ).toThrow(ValidationError);
  });
});
