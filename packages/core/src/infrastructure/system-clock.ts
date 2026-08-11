import type { Clock } from '../domain/ports/clock';

/**
 * The `Clock` port on the system clock. What M1 actually runs on -- the fake
 * that only moves when a test says so lives in `tests/helpers`.
 *
 * A class rather than a bare `{ now: () => new Date() }` object literal for the
 * reason the whole port exists: this is the ONE place in the shipped code where
 * `new Date()` is allowed to appear, and a named type makes that greppable.
 */
export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}
