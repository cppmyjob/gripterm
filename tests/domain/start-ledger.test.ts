import { StartLedger } from '../../packages/core/src/domain/services/start-ledger';
import type { Clock } from '../../packages/core/src/domain/ports/clock';

/**
 * The rule the breakdown of a start has to obey, stated before any of it is
 * wired into a composition root (Ш22).
 *
 * **Time on a clock is a measurement, not an assertion.** Nothing here says how
 * long anything takes -- a test that did would be a test of this machine on this
 * afternoon. What it says is the PROPERTY a breakdown must have for the numbers
 * beside it to mean anything:
 *
 *   * the parts and the leftover add up to the whole, exactly;
 *   * a part that was slowed down grows by what it was slowed by, and the
 *     leftover does not move;
 *   * a part that did not run is ABSENT, not nought -- because nought is a
 *     measurement and absent is the truth;
 *   * work done inside another part belongs to the inner one, so that every
 *     number printed is a slice of the whole no other number contains.
 *
 * The clock is a fake and it is stepped by hand, which is the only way any of
 * the four can be stated as an equality rather than a tolerance.
 */

/** A clock that moves only when this test moves it. */
class HandClock implements Clock {
  private _atMs: number;

  constructor(atMs: number) {
    this._atMs = atMs;
  }

  public get atMs(): number {
    return this._atMs;
  }

  public now(): Date {
    return new Date(this._atMs);
  }

  /** Moves the hands. Returns nothing on purpose: a step is not a measurement. */
  public step(ms: number): void {
    this._atMs += ms;
  }
}

/** The moment a window is pretending to have woken up. */
const WOKE_AT_MS = 1_786_500_000_000;

function ledgerOn(clock: HandClock): StartLedger {
  return new StartLedger({ clock, wokeAtMs: clock.atMs });
}

/**
 * One scripted start: some work nobody measures, three named parts, and more
 * work nobody measures. `agentsMs` is the knob the positive control turns.
 */
async function aStart(agentsMs: number): Promise<{ clock: HandClock, ledger: StartLedger }> {
  const clock = new HandClock(WOKE_AT_MS);
  const ledger = ledgerOn(clock);
  // Composition nobody times: this is what the leftover is made of.
  clock.step(7);
  await ledger.measure('readingTheStore', async () => {
    clock.step(120);
    return await Promise.resolve(null);
  });
  clock.step(3);
  await ledger.measure('theAgentListing', async () => {
    clock.step(agentsMs);
    return await Promise.resolve(null);
  });
  ledger.time('buildingTheList', () => {
    clock.step(11);
  });
  clock.step(5);
  return { clock, ledger };
}

function summed(phases: Readonly<Record<string, number>>): number {
  return Object.values(phases).reduce((total, ms) => total + ms, 0);
}

describe('the parts a start is made of', () => {
  it('adds the parts and the leftover up to the whole, exactly', async () => {
    const { ledger } = await aStart(600);
    const breakdown = ledger.breakdown();

    expect(breakdown.phases).toEqual({
      readingTheStore: 120,
      theAgentListing: 600,
      buildingTheList: 11,
    });
    // 7 + 3 + 5: the composition nobody timed, named as the leftover it is.
    expect(breakdown.remainderMs).toBe(15);
    expect(breakdown.tookMs).toBe(746);
    expect(summed(breakdown.phases) + breakdown.remainderMs).toBe(breakdown.tookMs);
  });

  it('measures the whole from waking, not from the first part', async () => {
    const clock = new HandClock(WOKE_AT_MS);
    const ledger = ledgerOn(clock);
    clock.step(400);
    await ledger.measure('findingTheCli', async () => {
      clock.step(10);
      return await Promise.resolve(null);
    });

    expect(ledger.breakdown().tookMs).toBe(410);
    expect(ledger.breakdown().remainderMs).toBe(400);
  });

  it('leaves a part that never ran OUT, rather than reporting it as nought', async () => {
    const { ledger } = await aStart(600);
    const { phases } = ledger.breakdown();

    expect(Object.keys(phases)).not.toContain('bringingTerminalsBack');
    expect(phases.bringingTerminalsBack).toBeUndefined();
  });

  it('reports a part that ran and cost nothing as nought, because that is a measurement', () => {
    const clock = new HandClock(WOKE_AT_MS);
    const ledger = ledgerOn(clock);
    ledger.time('endingTheirProcesses', () => undefined);

    expect(ledger.breakdown().phases).toEqual({ endingTheirProcesses: 0 });
  });

  it('grows the part that was slowed down, and nothing else', async () => {
    const quick = (await aStart(600)).ledger.breakdown();
    const slow = (await aStart(2600)).ledger.breakdown();

    expect((slow.phases.theAgentListing ?? 0) - (quick.phases.theAgentListing ?? 0)).toBe(2000);
    expect(slow.phases.readingTheStore).toBe(quick.phases.readingTheStore);
    expect(slow.phases.buildingTheList).toBe(quick.phases.buildingTheList);
    // The whole point of the control: the leftover did not absorb any of it.
    expect(slow.remainderMs).toBe(quick.remainderMs);
    expect(slow.tookMs - quick.tookMs).toBe(2000);
  });

  it('keeps the order the parts happened in', async () => {
    const { ledger } = await aStart(600);

    expect(Object.keys(ledger.breakdown().phases)).toEqual([
      'readingTheStore',
      'theAgentListing',
      'buildingTheList',
    ]);
  });

  it('counts work done inside a part to the inner one, and leaves the outer its own', async () => {
    const clock = new HandClock(WOKE_AT_MS);
    const ledger = ledgerOn(clock);
    await ledger.measure('readingTheMachine', async () => {
      clock.step(40);
      await ledger.measure('theTranscriptIndex', async () => {
        clock.step(1200);
        return await Promise.resolve(null);
      });
      clock.step(10);
      await ledger.measure('theAgentListing', async () => {
        clock.step(600);
        return await Promise.resolve(null);
      });
      clock.step(5);
      return await Promise.resolve(null);
    });
    const breakdown = ledger.breakdown();

    expect(breakdown.phases).toEqual({
      readingTheMachine: 55,
      theTranscriptIndex: 1200,
      theAgentListing: 600,
    });
    expect(summed(breakdown.phases) + breakdown.remainderMs).toBe(breakdown.tookMs);
    expect(breakdown.remainderMs).toBe(0);
  });

  it('adds up the second visit to a part rather than replacing the first', () => {
    const clock = new HandClock(WOKE_AT_MS);
    const ledger = ledgerOn(clock);
    ledger.time('buildingTheList', () => { clock.step(4); });
    clock.step(2);
    ledger.time('buildingTheList', () => { clock.step(6); });

    expect(ledger.breakdown().phases).toEqual({ buildingTheList: 10 });
    expect(ledger.breakdown().remainderMs).toBe(2);
  });

  it('counts a part that is still running up to now, so that nothing hides in the leftover', async () => {
    const clock = new HandClock(WOKE_AT_MS);
    const ledger = ledgerOn(clock);
    const done = ledger.measure('bringingTerminalsBack', async () => {
      clock.step(300);
      return await Promise.resolve('back');
    });
    // Read while the work is still in flight: the phase must already own its 300.
    const midway = ledger.breakdown();

    expect(midway.phases).toEqual({ bringingTerminalsBack: 300 });
    expect(midway.remainderMs).toBe(0);
    expect(summed(midway.phases) + midway.remainderMs).toBe(midway.tookMs);
    expect(await done).toBe('back');
  });

  it('hands back what the work returned, and lets a failure through unchanged', async () => {
    const clock = new HandClock(WOKE_AT_MS);
    const ledger = ledgerOn(clock);

    expect(ledger.time('buildingTheList', () => 'the tree')).toBe('the tree');
    await expect(
      ledger.measure('openingThePort', async () => {
        clock.step(9);
        await Promise.resolve();
        throw new Error('the port would not open');
      })
    ).rejects.toThrow('the port would not open');
    // And the part it failed in is still counted: a failure took time too.
    expect(ledger.breakdown().phases.openingThePort).toBe(9);
  });
});
