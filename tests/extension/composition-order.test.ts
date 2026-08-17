import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Two rules of the composition root that nothing running can check, held by
 * reading the file that states them (M3.5).
 *
 * Both are about ORDER, both are silent when broken, and both refuse to be
 * exercised where they matter. The pass that ends other windows' processes is
 * refused in a test host on purpose -- a test run must not end anybody's
 * conversations -- so no integration test can watch it happen at the right
 * moment; and `deactivate` runs when the extension host is going away, which is
 * after every suite has finished.
 *
 * Reading the source is a weak instrument and it is the honest one here: the
 * alternative is a comment, and a comment is a trace that can be not read
 * (§II.6). What this cannot see is whether the calls do what their names say --
 * that is what the unit suites of `orphan-processes` and `window-shutdown` are
 * for. What it can see is somebody moving one line above another.
 */

const SOURCE = readFileSync(
  join(__dirname, '..', '..', 'packages', 'extension', 'src', 'extension.ts'),
  'utf8'
);

function bodyOf(name: string): string {
  const start = SOURCE.indexOf(`export async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = SOURCE.indexOf('\n}', start);
  expect(next).toBeGreaterThan(start);
  return SOURCE.slice(start, next);
}

describe('the order activation keeps', () => {
  it('ends the processes of windows that are gone BEFORE it reads the machine', () => {
    /*
     * M3.5(г). `deadPids` is gathered once, by `gatherRestoreInputs` inside
     * `surveyTheMachine`, and every gate of the restore is answered from that one
     * reading. A process ended after it would still count as running -- so the
     * records of the window that left it behind would be refused, in the same
     * activation that had just taken their process away.
     */
    const body = bodyOf('activate');
    const ending = body.indexOf('endTheirProcesses(');
    const survey = body.indexOf('surveyTheMachine(');

    expect(ending).toBeGreaterThan(-1);
    expect(survey).toBeGreaterThan(-1);
    expect(ending).toBeLessThan(survey);
  });
});

describe('the order a window leaves in', () => {
  it('ends its own processes before it awaits anything', () => {
    /*
     * M3.5. The platform gives a closing window a few seconds for the whole of
     * `deactivate`, and everything else in it is writing down what has already
     * happened -- a flush that took its time would spend that budget before a
     * single `claude` of ours had been ended. This is also the only act in the
     * function that needs the host to still be there.
     */
    const body = bodyOf('deactivate');
    const ending = body.indexOf('ending?.()');
    const firstAwait = body.indexOf('await ');

    expect(ending).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(-1);
    expect(ending).toBeLessThan(firstAwait);
  });
});
