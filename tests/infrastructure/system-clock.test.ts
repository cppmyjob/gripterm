import { SystemClock } from '../../packages/core/src/index';

describe('SystemClock', () => {
  it('reads the system clock', () => {
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('hands out a fresh Date each time', () => {
    // `Object.freeze` does not reach a Date's internal slots, so a shared
    // instance stays mutable through `setTime` -- and every timestamp this
    // extension stores comes through here.
    const clock = new SystemClock();
    const first = clock.now();
    const second = clock.now();

    expect(first).not.toBe(second);

    first.setTime(0);
    expect(clock.now().getTime()).toBeGreaterThan(0);
  });
});
