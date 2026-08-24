import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The deadline every test in this run is measured against.
 *
 * Jest gives a test 5000 ms by default and nothing in this repository chose
 * that number. It is a HANG detector, not a promise about speed -- and this run
 * starves it. Measured 2026-08-24, over forty full parallel runs on this
 * machine: `boundaries.test.ts` holds a whole type-aware ESLint program in a
 * child process for nine seconds and `packaging.test.ts` runs `npx vsce ls` for
 * five, both starting in the first second, while the workers beside them do
 * real file system work. One of the forty runs went red with three tests over
 * the deadline whose own work is 25 ms, 38 ms and 2171 ms -- none of them slow,
 * all of them starved. Under a load that made the run 5.7x slower the same
 * failure comes on demand, and the three it picked there were a DIFFERENT
 * three, which is the whole point: this is not one test's race, it is the
 * stopwatch being eaten by the neighbours.
 *
 * This reads the file rather than jest's resolved configuration, because jest
 * offers a running test no way to ask what deadline it is being held to. What
 * it pins is therefore the DECISION and not the effect -- and the decision
 * lives in that file, where a later reader looking for the reason will find the
 * measurement written next to the number.
 */

const REPO_ROOT = join(__dirname, '..');

/** The `testTimeout` the unit run names, or null when it names none and takes jest's default. */
function configuredDeadlineMs(): number | null {
  const config = readFileSync(join(REPO_ROOT, 'jest.config.js'), 'utf8');
  const named = /^\s*testTimeout:\s*(?<ms>[\d_]+)\s*,/mu.exec(config);
  const digits = named?.groups?.ms;
  return digits === undefined ? null : Number(digits.replaceAll('_', ''));
}

/**
 * The longest wait this suite makes ON PURPOSE, taken from the program that
 * makes it.
 *
 * The forwarder is bounded by its own two ceilings, and `forwarder.test.ts`
 * spends both of them in real time -- 2171 ms measured, eight times the next
 * slowest test here. Read from its source rather than copied, so that raising
 * the forwarder's ceiling cannot quietly leave the deadline behind it.
 */
function forwarderCeilingMs(): number {
  const source = readFileSync(
    join(REPO_ROOT, 'packages', 'extension', 'assets', 'gripterm-forwarder.js'),
    'utf8'
  );
  const ceilings = [...source.matchAll(/^const \w*TIMEOUT_MS = (?<ms>\d+);$/gmu)].map((found) =>
    Number(found.groups?.ms)
  );
  if (ceilings.length === 0) {
    throw new Error('the forwarder names no timeout at all, so there is nothing to measure against');
  }
  return Math.max(...ceilings);
}

describe('the deadline the unit run holds every test to', () => {
  it('is chosen by this repository rather than taken from jest', () => {
    expect(configuredDeadlineMs()).not.toBeNull();
  });

  /*
   * Ten times, and the multiple is about the MACHINE rather than about the
   * test: under the load above, an ordinary 38 ms file system test took 8.4 s,
   * which is 220 times its own cost. A deadline sized to what the work needs
   * measures how busy the box is; one sized well past it measures whether
   * anything hung.
   */
  it('leaves room for the slowest wait this suite makes on purpose', () => {
    expect(configuredDeadlineMs() ?? 0).toBeGreaterThanOrEqual(forwarderCeilingMs() * 10);
  });
});
