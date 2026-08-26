import { judgeTheStart, startTimesIn } from './start-budget';
import type { StartBudget, StartReading } from './start-budget';

/**
 * The budget of the start, checked without a machine.
 *
 * The same cut as `judge.ts`: the stand's measuring half needs an editor and
 * four minutes, and everything about WHAT THE NUMBERS MEAN is a function from
 * numbers to a verdict. So "the check goes red when the budget is too small for
 * the run" is settled here, in under a second, on any machine -- which is the
 * only way a green stand means anything at all. A check that cannot be shown
 * going red is a check nobody has tested.
 */

/** Two lines exactly as `FileLog.format` writes them. */
const LOG = [
  '2026-08-26T09:14:02.001Z info Gripterm is waking up',
  '2026-08-26T09:14:03.114Z info the list of terminals is on screen {"tookMs":1113,"rows":4}',
  '2026-08-26T09:14:05.902Z info a window was asked whether it is still there {"liveness":"live"}',
  '2026-08-26T09:14:06.777Z info Gripterm activated {"tookMs":4776,"trustedWorkspace":true,"rows":4}',
].join('\n');

const ROOMY: StartBudget = { listedMs: 5000, activatedMs: 20_000 };

function readings(...pairs: readonly (readonly [number, number])[]): readonly StartReading[] {
  return pairs.map(([listedMs, activatedMs], at) => ({ sitting: at + 1, listedMs, activatedMs }));
}

describe('the two numbers the product already prints', () => {
  it('reads both out of a window`s own log', () => {
    expect(startTimesIn(LOG)).toEqual({ listedMs: 1113, activatedMs: 4776 });
  });

  it('says nothing rather than nought when the window never got that far', () => {
    const died = '2026-08-26T09:14:02.001Z info Gripterm is waking up';

    expect(startTimesIn(died)).toEqual({ listedMs: null, activatedMs: null });
  });

  it('is not fooled by a line that merely mentions the sentence', () => {
    const quoted = '2026-08-26T09:14:02.001Z warn a listener failed {"cause":"the list of terminals is on screen"}';

    expect(startTimesIn(quoted)).toEqual({ listedMs: null, activatedMs: null });
  });

  it('takes the last activation in a file that holds more than one', () => {
    const twice = [
      'x info Gripterm activated {"tookMs":1}',
      'x info Gripterm activated {"tookMs":2}',
    ].join('\n');

    expect(startTimesIn(twice).activatedMs).toBe(2);
  });
});

describe('the budget of the start', () => {
  it('is green when every sitting was inside it', () => {
    const verdict = judgeTheStart(readings([1113, 4776], [980, 3900], [1400, 5200]), ROOMY);

    expect(verdict.answer).toBe('green');
    expect(verdict.over).toBe(0);
  });

  /*
   * THE POSITIVE CONTROL, and the reason this file exists at all. A budget check
   * that cannot be shown going red is a check that passes on anything -- which
   * is exactly how a stand goes green about nothing. Same readings, a budget
   * lowered on purpose, and the answer has to turn.
   */
  it('goes red on the very same run when the budget is lowered on purpose', () => {
    const same = readings([1113, 4776], [980, 3900], [1400, 5200]);

    const verdict = judgeTheStart(same, { listedMs: 1000, activatedMs: 4000 });

    expect(verdict.answer).toBe('red');
    // Sitting 1 over on both numbers, sitting 3 over on both, sitting 2 over on
    // neither: four pairs.
    expect(verdict.over).toBe(4);
    expect(verdict.because).toMatch(/1113/u);
    expect(verdict.because).toMatch(/sitting 1/u);
  });

  it('is red when one number of one sitting is over, and names it', () => {
    const verdict = judgeTheStart(readings([1113, 4776], [980, 30_000]), ROOMY);

    expect(verdict.answer).toBe('red');
    expect(verdict.over).toBe(1);
    expect(verdict.because).toMatch(/sitting 2/u);
    expect(verdict.because).toMatch(/30000/u);
  });

  /*
   * `unmeasured` is not a pass, for the reason `judge.ts` says it in more words:
   * a run that reports green for a question its recording never asked is worse
   * than one that does not run.
   */
  it('is unmeasured, and not green, when no sitting said how long it took', () => {
    const silent = [{ sitting: 1, listedMs: null, activatedMs: null }];

    const verdict = judgeTheStart(silent, ROOMY);

    expect(verdict.answer).toBe('unmeasured');
  });

  it('is unmeasured when there is nothing at all to read', () => {
    expect(judgeTheStart([], ROOMY).answer).toBe('unmeasured');
  });

  it('judges the sittings that spoke and says how many did not', () => {
    const half = [
      { sitting: 1, listedMs: 1113, activatedMs: 4776 },
      { sitting: 2, listedMs: null, activatedMs: null },
    ];

    const verdict = judgeTheStart(half, ROOMY);

    expect(verdict.answer).toBe('green');
    expect(verdict.because).toMatch(/sitting 2/u);
  });
});
