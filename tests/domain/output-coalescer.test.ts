import { COALESCE_WINDOW_MS, OutputCoalescer } from '../../packages/core/src/index';
import { FakeScheduler } from '../helpers/port-fakes';

/**
 * The rule that turns a pty's chunks into messages, and the measurement it is.
 *
 * M3.2 stage B, §6: the same 1.84 million characters reached the page as **163
 * messages** one chunk at a time and as **10** with a 16 ms window -- 24 to 29
 * times fewer, with no loss and no added latency (the receipt came back FASTER
 * coalesced: 17.5 ms mean against 48.1). So the format of this channel is a
 * joined string on a timer, and the timer is the measured one.
 *
 * Everything here is driven by a fake scheduler, so what is tested is the rule
 * rather than the machine's mood.
 */

function coalescerWith(scheduler: FakeScheduler, windowMs?: number): {
  readonly coalescer: OutputCoalescer;
  readonly delivered: string[];
} {
  const delivered: string[] = [];
  const deliver = (text: string): void => { delivered.push(text); };
  // The two shapes rather than one with `undefined` in it: this build compiles
  // with `exactOptionalPropertyTypes`, where an absent field and a field holding
  // `undefined` are different types -- and the default is what the first case is
  // testing.
  const coalescer = new OutputCoalescer(
    windowMs === undefined ? { scheduler, deliver } : { scheduler, deliver, windowMs }
  );
  return { coalescer, delivered };
}

describe('the window this build joins output in', () => {
  it('is the measured one', () => {
    expect(COALESCE_WINDOW_MS).toBe(16);
  });
});

describe('a coalescer collecting a burst', () => {
  it('delivers one message for everything that arrived in the window, in order', () => {
    const scheduler = new FakeScheduler();
    const { coalescer, delivered } = coalescerWith(scheduler);

    coalescer.take('one ');
    coalescer.take('two ');
    coalescer.take('three');

    expect(delivered).toStrictEqual([]);
    expect(scheduler.live).toHaveLength(1);
    expect(scheduler.live[0]?.ms).toBe(COALESCE_WINDOW_MS);

    scheduler.elapse();

    expect(delivered).toStrictEqual(['one two three']);
  });

  it('arms a fresh window for what comes after a delivery', () => {
    const scheduler = new FakeScheduler();
    const { coalescer, delivered } = coalescerWith(scheduler);

    coalescer.take('first');
    scheduler.elapse();
    coalescer.take('second');
    scheduler.elapse();

    expect(delivered).toStrictEqual(['first', 'second']);
  });

  it('ignores the empty chunks a pty produces', () => {
    // node-pty emits them. An empty chunk that armed a window would mean a
    // message carrying nothing, and a page that cleared its screen for it.
    const scheduler = new FakeScheduler();
    const { coalescer, delivered } = coalescerWith(scheduler);

    coalescer.take('');

    expect(scheduler.live).toStrictEqual([]);
    expect(coalescer.pendingChars).toBe(0);
    expect(delivered).toStrictEqual([]);
  });

  it('says how much is waiting, so a caller can count what it has not sent', () => {
    const scheduler = new FakeScheduler();
    const { coalescer } = coalescerWith(scheduler);

    coalescer.take('12345');

    expect(coalescer.pendingChars).toBe(5);

    scheduler.elapse();

    expect(coalescer.pendingChars).toBe(0);
  });
});

describe('a coalescer asked to hurry', () => {
  it('delivers what it holds at once and does not deliver it twice', () => {
    // The end of a process is the case: the last line of an agent's output must
    // not wait on a window that a dead pty will never fill.
    const scheduler = new FakeScheduler();
    const { coalescer, delivered } = coalescerWith(scheduler);
    coalescer.take('the last line');

    coalescer.flush();

    expect(delivered).toStrictEqual(['the last line']);
    expect(scheduler.live).toStrictEqual([]);
  });

  it('delivers nothing when it holds nothing', () => {
    const scheduler = new FakeScheduler();
    const { coalescer, delivered } = coalescerWith(scheduler);

    coalescer.flush();

    expect(delivered).toStrictEqual([]);
  });

  it('does not deliver the same text twice to a consumer that asks for more mid-delivery', () => {
    /*
     * The ordering promise, made explicit because nothing in this build
     * currently provokes it and a mutation therefore survived it (M9 of the M3.7
     * battery, 2026-08-18): what is held is cleared BEFORE it is handed over, so
     * a consumer that calls back into the coalescer from inside `deliver` finds
     * it empty rather than finds the same text again.
     *
     * The consumer that will do this is the one after next: a sink that decides,
     * on receiving a message, that the rest must go out now.
     */
    const scheduler = new FakeScheduler();
    const delivered: string[] = [];
    let coalescer: OutputCoalescer | null = null;
    coalescer = new OutputCoalescer({
      scheduler,
      deliver: (text) => {
        delivered.push(text);
        coalescer?.flush();
      },
    });

    coalescer.take('once');
    scheduler.elapse();

    expect(delivered).toStrictEqual(['once']);
  });
});

describe('a coalescer that has been let go', () => {
  it('cancels the window it was waiting out and delivers nothing', () => {
    const scheduler = new FakeScheduler();
    const { coalescer, delivered } = coalescerWith(scheduler);
    coalescer.take('into the void');

    coalescer.dispose();

    expect(scheduler.live).toStrictEqual([]);
    expect(delivered).toStrictEqual([]);
  });

  it('takes nothing more, so a late chunk cannot arm a window nobody cancels', () => {
    const scheduler = new FakeScheduler();
    const { coalescer, delivered } = coalescerWith(scheduler);
    coalescer.dispose();

    coalescer.take('after the end');
    coalescer.flush();

    expect(scheduler.live).toStrictEqual([]);
    expect(delivered).toStrictEqual([]);
    expect(coalescer.pendingChars).toBe(0);
  });

  it('is let go twice without complaint', () => {
    const scheduler = new FakeScheduler();
    const { coalescer } = coalescerWith(scheduler);
    coalescer.take('something');

    coalescer.dispose();

    expect(() => { coalescer.dispose(); }).not.toThrow();
  });
});

describe('what a coalescer refuses', () => {
  it.each([
    ['a window that is not a number', Number.NaN],
    ['a window with no end', Number.POSITIVE_INFINITY],
    ['a negative window', -1],
    ['a fraction of a millisecond', 0.5],
  ])('refuses %s', (_what, windowMs) => {
    const scheduler = new FakeScheduler();

    expect(() => coalescerWith(scheduler, windowMs)).toThrow(/whole, positive count/u);
  });

  it('accepts a window of nothing, which is a caller that wants no joining', () => {
    const scheduler = new FakeScheduler();
    const { coalescer, delivered } = coalescerWith(scheduler, 0);

    coalescer.take('now');
    scheduler.elapse();

    expect(delivered).toStrictEqual(['now']);
  });
});
