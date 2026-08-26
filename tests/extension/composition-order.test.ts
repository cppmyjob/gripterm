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

/*
 * The three rules of Ш11 that live in the composition root, held the same weak
 * honest way as the two above: by reading the file that states them.
 *
 * **This is a source-reading test and it is named as one.** What it can see is
 * somebody moving one line, or re-pointing one subscription. What it cannot see
 * is whether the objects behave -- that is what
 * `tests/infrastructure/repository-watcher.test.ts` and
 * `tests/domain/reconciler.test.ts` are for, and both of those are behaviour.
 * The wiring itself has no seam a unit test can reach: `activate` needs a real
 * extension host, and an integration suite runs after activation is over.
 */
describe('what activation does NOT put on the path of the first list', () => {
  it('wakes the cross-window sweep from the store`s watcher, not from its own repository', () => {
    /*
     * Ш11, cause 2. `shared.repository.watch` fires on what THIS window writes,
     * so every record the restore laid down woke a full pass -- inside the
     * restore, and the first one finds no previous pass, so nothing holds it
     * back. Measured with `spikes/start-budget/activation-spawns.mjs`: one
     * `claude agents --json` of 0.56-0.70 s, gone when the same listener hangs
     * off the watcher's presence signal instead.
     */
    const body = bodyOf('activate');

    expect(body).toContain('shared.watchPresence(');
    expect(body).not.toContain('shared.repository.watch(');
  });

  it('does not wait for `claude --version` before the list is on screen', () => {
    /*
     * Ш11, cause 3. The probe is a process spawn -- 87 to 96 ms over four runs
     * on this machine on 2026-08-26 -- and nothing before the list needs its
     * answer: `launchReadiness` takes the PATH, not the version. So it is
     * started early and awaited late, and the only thing that waits for it is
     * the line that prints it.
     */
    const body = bodyOf('activate');
    const onScreen = body.indexOf('the list of terminals is on screen');
    const awaited = body.indexOf('await cliVersion');

    expect(onScreen).toBeGreaterThan(-1);
    expect(awaited).toBeGreaterThan(-1);
    expect(onScreen).toBeLessThan(awaited);
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

/*
 * The voice of the one pass that takes a record without asking (Ш15), held the
 * same weak honest way and named as one.
 *
 * `forgetClosedTerminals` runs during activation, from a plan made against a
 * world gathered before mocha loads its first file -- so no suite in a running
 * host can put a closed record of a window that is gone in front of it at the
 * right moment. `forgottenNotice` has its own tests in `tests/domain`, and what
 * NOTHING else can see is whether anybody still calls it: a sentence that is
 * composed and never handed to the announcer is exactly the silence this step
 * existed to end.
 */
describe('what activation says about the records it forgets', () => {
  it('hands the pass a way to speak, and the pass uses it', () => {
    const activation = bodyOf('activate');
    const called = activation.indexOf('forgetClosedTerminals({');
    expect(called).toBeGreaterThan(-1);
    expect(activation.slice(called, activation.indexOf('});', called))).toContain('announce:');

    // From the opening brace of the BODY, not of the parameter object: the
    // parts are declared inline, so the first `\n}` is theirs.
    const pass = SOURCE.slice(SOURCE.indexOf('async function forgetClosedTerminals('));
    const opens = pass.indexOf('): Promise<void> {');
    expect(opens).toBeGreaterThan(-1);
    const body = pass.slice(opens, pass.indexOf('\n}', opens));
    expect(body).toContain('forgottenNotice({');
    expect(body).toContain('announce(notice)');
  });
});
