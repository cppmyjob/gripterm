import { OneTurnAtATime } from '../../packages/core/src/index';

/**
 * One queue instead of one boolean, and the difference between them is the
 * whole reason this file exists.
 *
 * **What was there before, and what it cost.** `VsCodeEditorStrip` guarded
 * three of its four entrances with a field called `_arranging`: true while the
 * object was moving groups about, and every entrance that found it true
 * RETURNED. That is a lock which drops what it refuses. The editor announces a
 * tab or a group in bursts, and a burst that arrives while a turn is running is
 * exactly the burst that says the thing the turn was reading has changed --
 * so the one wake-up that mattered was the one guaranteed to be thrown away.
 * Measured on the stand, 2026-08-25: the strip was given a third of the editor
 * area, the second terminal opened, the workbench took the space back, and the
 * sighting the stand judges shows the strip holding 0.906 of its family with
 * nothing left to ask again.
 *
 * A queue answers the same question -- "not now" -- without losing it. Two
 * kinds of turn, because the callers are two kinds:
 *
 *   * `ask` is somebody waiting for an answer (a column to open a terminal in),
 *     and every one of them has to run;
 *   * `nudge` is an event saying the window moved, and a dozen of those are one
 *     piece of work. They collapse WHILE THEY WAIT and never while one is
 *     running: a nudge that arrives during a turn of the same name is the case
 *     the boolean lost, and it is the one case that must queue another.
 */
describe('one turn at a time', () => {
  /** A promise a test opens by hand, so that nothing here waits on a clock. */
  interface Gate {
    readonly opened: Promise<void>;
    readonly open: () => void;
  }

  function gate(): Gate {
    let release: (() => void) | null = null;
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      opened,
      open: (): void => {
        if (release === null) {
          throw new Error('the gate was opened before it was built');
        }
        release();
      },
    };
  }

  /** Everything the queue did, in the order it did it. */
  function diary(): { readonly wrote: string[] } {
    return { wrote: [] };
  }

  function queueThatRecordsFailures(): {
    readonly turns: OneTurnAtATime;
    readonly failed: { what: string, cause: unknown }[];
  } {
    const failed: { what: string, cause: unknown }[] = [];
    const turns = new OneTurnAtATime({
      onFailed: (failure) => {
        failed.push({ what: failure.what, cause: failure.cause });
      },
    });
    return { turns, failed };
  }

  it('never lets two turns overlap', async () => {
    const { turns } = queueThatRecordsFailures();
    const log = diary();
    const first = gate();

    const one = turns.ask('one', async () => {
      log.wrote.push('one in');
      await first.opened;
      log.wrote.push('one out');
      return 1;
    });
    const two = turns.ask('two', async () => {
      log.wrote.push('two in');
      return 2;
    });

    // The second has been asked for and has not started: the first is holding
    // the queue, and nothing about it has been thrown away.
    await Promise.resolve();
    expect(log.wrote).toEqual(['one in']);

    first.open();
    expect(await one).toBe(1);
    expect(await two).toBe(2);
    expect(log.wrote).toEqual(['one in', 'one out', 'two in']);
  });

  it('keeps a nudge that arrives while a turn of the same name is running', async () => {
    const { turns } = queueThatRecordsFailures();
    const log = diary();
    const held = gate();
    let runs = 0;

    const work = async (): Promise<void> => {
      runs += 1;
      log.wrote.push(`settle ${String(runs)} in`);
      if (runs === 1) {
        await held.opened;
      }
      log.wrote.push(`settle ${String(runs)} out`);
    };

    turns.nudge('settle', work);
    await Promise.resolve();
    // The editor moved something WHILE the first turn was reading the window.
    // This is the wake-up `_arranging` dropped.
    turns.nudge('settle', work);

    held.open();
    await turns.whenEmpty();

    expect(runs).toBe(2);
    expect(log.wrote).toEqual(['settle 1 in', 'settle 1 out', 'settle 2 in', 'settle 2 out']);
  });

  it('collapses nudges of one name that are all still waiting', async () => {
    const { turns } = queueThatRecordsFailures();
    const held = gate();
    let settles = 0;

    void turns.ask('hold the queue', async () => {
      await held.opened;
    });
    for (let burst = 0; burst < 12; burst += 1) {
      turns.nudge('settle', async () => {
        settles += 1;
        await Promise.resolve();
      });
    }

    held.open();
    await turns.whenEmpty();

    // A burst of a dozen events is one piece of work, and the queue does not
    // grow with the noise.
    expect(settles).toBe(1);
  });

  it('runs turns in the order they were asked for', async () => {
    const { turns } = queueThatRecordsFailures();
    const log = diary();
    const held = gate();

    void turns.ask('first', async () => {
      await held.opened;
      log.wrote.push('first');
    });
    turns.nudge('settle', async () => {
      log.wrote.push('settle');
      await Promise.resolve();
    });
    const last = turns.ask('last', async () => {
      log.wrote.push('last');
      return 'done';
    });

    held.open();
    expect(await last).toBe('done');
    expect(log.wrote).toEqual(['first', 'settle', 'last']);
  });

  it('lets an asked turn throw at the caller and keeps the queue running', async () => {
    const { turns, failed } = queueThatRecordsFailures();
    const log = diary();

    const angry = turns.ask('angry', async () => {
      await Promise.resolve();
      throw new Error('the editor would not');
    });
    const after = turns.ask('after', async () => {
      log.wrote.push('after');
      return 'still here';
    });

    await expect(angry).rejects.toThrow('the editor would not');
    expect(await after).toBe('still here');
    // An asked turn answers its own caller; nothing is reported twice.
    expect(failed).toEqual([]);
  });

  it('reports a nudged turn that throws, because nobody is waiting for its answer', async () => {
    const { turns, failed } = queueThatRecordsFailures();
    const log = diary();

    turns.nudge('settle', async () => {
      await Promise.resolve();
      throw new Error('the grid was not there');
    });
    void turns.ask('after', async () => {
      log.wrote.push('after');
    });

    await turns.whenEmpty();

    expect(failed).toHaveLength(1);
    expect(failed[0]?.what).toBe('settle');
    expect(String(failed[0]?.cause)).toContain('the grid was not there');
    expect(log.wrote).toEqual(['after']);
  });

  it('says what it is doing and what is waiting, because a log has to name the turn', async () => {
    const { turns } = queueThatRecordsFailures();
    const held = gate();

    expect(turns.running).toBeNull();
    expect(turns.waiting).toEqual([]);

    const one = turns.ask('a group for the terminals', async () => {
      await held.opened;
    });
    turns.nudge('the window settled', async () => {
      await Promise.resolve();
    });
    await Promise.resolve();

    expect(turns.running).toBe('a group for the terminals');
    expect(turns.waiting).toEqual(['the window settled']);

    held.open();
    await one;
    await turns.whenEmpty();
    expect(turns.running).toBeNull();
    expect(turns.waiting).toEqual([]);
  });
});
