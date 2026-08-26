'use strict';

const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const assert = require('node:assert');
const vscode = require('vscode');
const { CLASSIC, workbenchOf } = require(join(__dirname, '..', '..', 'tools', 'cursor-workbench.js'));

/**
 * The Cursor strip: what the FORK'S WORKBENCH does, measured in the fork.
 *
 * **Why this is not an integration suite.** This heading ended "and cannot be"
 * until 2026-08-25, on the strength of three launches: Cursor's extension TEST
 * host -- any window carrying `--extensionTestsPath` -- registering no
 * third-party extension at all, 48 entries in `vscode.extensions.all` and ours
 * absent. As a statement about the TEST HOST, that is REFUTED. Measured the same
 * day over 33 launches driving `Cursor.exe` directly: the refusal belongs to the
 * fork's GLASS window and to nothing else. A glass window answers 48 with ours
 * absent, 5 launches out of 5. The same host outside glass answers 113 with ours
 * among them -- 12 launches of 12 under `--classic`, 6 of 6 with no flag but a
 * folder to open, 3 of 3 under `--glass --classic`. So the live suites in Cursor
 * are UNRUN rather than impossible; what keeps them out is a price (4 min 30 s
 * onto a gate near its ceiling) and an unanswered question about which window
 * this stage should open, both recorded in the `cursor-live` entry of
 * `tools/gate.mjs`. In a glass window the old sentence still holds:
 * `vscode.extensions.getExtension('gripterm-placeholder.gripterm')` is
 * `undefined` there, and every suite under `tests/integration` begins by
 * asserting it is not.
 *
 * **What is left, and why it is worth a stage anyway.** All four of the
 * customer's defects are layout, and every one of them is the fork's workbench
 * doing something VS Code does not. That part needs no extension of ours: a
 * command and two read-only APIs measure it. `spikes/cursor-probe` found the
 * defect of 2026-08-22 exactly this way, by hand, and this is that spike given
 * a budget, a ceiling and a place in the gate.
 *
 * **Which workbench these numbers are about, and it is now written down.** The
 * two of them answer differently to the same command -- 10 misses of 10 in
 * glass, none of 10 outside it -- and the fork's API names neither, so until
 * 2026-08-26 this file recorded a rate with no subject. It reads the workbench
 * out of the fork's own log tree instead, by two signals at once (the per-window
 * log directory is `window1_wb0` in glass and `window1` outside it; the fork's
 * own extension writes `"layout":"glass"` beside it), and puts BOTH READINGS in
 * `rate.json` so that a reader can recount the conclusion rather than take it.
 * Where they disagree, or where neither could be read, the answer is `unknown`
 * and the numbers are not judged at all -- see `tools/cursor-workbench.js`.
 *
 * **What this stage therefore does NOT cover, said here as well as in the
 * gate's own list:** the product, in Cursor, under a test host. Nothing here
 * EXERCISES Gripterm -- and since 2026-08-25 that is no longer the same sentence
 * as "nothing here loads it". A window that is not glass registers our
 * extension, and the window this label opens is not a glass one. Whether THIS
 * window has it in `extensions.all` has never been asked, because nothing here
 * asks. What covers the product in Cursor is `pnpm run test:stand`, which uses a
 * DEV host -- no `--extensionTestsPath` -- where the extension does load,
 * measured the same day.
 *
 * **The exit code of this run means nothing, and the reason got stronger.** It
 * was written down on 2026-08-25 as a stable rule: a Cursor test host running a
 * deliberately failing mocha file printed `1 failing` and exited 0, where VS
 * Code exited 1 on the same file. Over 33 launches the same day it turned out to
 * FLICKER: 5 launches of 12 under `--classic` exited 1, 1 of 4 under `--glass`,
 * 0 of 6 with no flag, and four identical consecutive launches gave 1, 0, 0, 1.
 * A host that always exits 0 can be worked around by a rule -- never believe its
 * exit code -- while a flicker cannot even be caught, because a run that exits 1
 * for a reason of its own is indistinguishable from a run that failed. So this
 * writes its numbers to `GRIPTERM_CURSOR_OUT` and `tools/gate.mjs` judges the
 * FILE: the same conclusion as before, now standing on the stronger reason. The
 * assertion at the end of each check is for a person running it by hand; it is
 * not what the gate reads.
 */

/** Where the numbers go, for a machine to do arithmetic on. */
const OUT = process.env.GRIPTERM_CURSOR_OUT;

/**
 * The build of the editor that answered, as the runner read it out of the
 * editor's own `product.json` before this window existed.
 *
 * From outside rather than from `vscode.version`, because those are two
 * different facts: Cursor 3.17.19 answers `1.128.0` there, which is the VS Code
 * it is a fork OF, and a workbench measurement attributed to `1.128.0` is
 * attributed to a build that never had this workbench in it.
 */
const BUILD = process.env.GRIPTERM_CURSOR_BUILD;

/**
 * The profile this window was started on, where its own logs land.
 *
 * Handed in by the runner. The extension host's `process.argv` is not the
 * editor's, and a suite that guessed the default profile directory would read
 * some other window's logs and report which workbench THAT was.
 */
const USER_DATA = process.env.GRIPTERM_CURSOR_USER_DATA;

/** The reading, taken once and kept, so that the record holds one of them. */
let read = null;

/**
 * Which workbench of the fork this window is, read from its own logs.
 *
 * **Taken LATE and only once.** The window is writing the very logs this reads,
 * and the `"layout":"glass"` line is written by the fork's own extension rather
 * than by us -- so the later it is read, the more of that log exists. First call
 * is at the END of the check below, after ten attempts have passed through the
 * workbench; `suiteTeardown` then reuses it, because two readings in one run
 * would leave two answers and no way to say which is the record.
 *
 * A failure to read is `unknown` and never a guess: an unestablished workbench
 * makes this run unjudgeable, which is red, and that is the same choice the gate
 * already makes about a missing `rate.json`.
 *
 * @returns {{is: string, because: string, read: object | null}} the answer and its readings
 */
function workbench() {
  if (read !== null) {
    return read;
  }
  if (USER_DATA === undefined) {
    read = {
      is: 'unknown',
      because: 'the runner did not name this window`s user data directory, so no log of it could be found',
      read: null,
    };
    return read;
  }
  try {
    read = workbenchOf(USER_DATA);
  } catch (failed) {
    read = {
      is: 'unknown',
      because:
        'the log tree of this window`s profile could not be read: ' +
        (failed instanceof Error ? failed.message : String(failed)),
      read: null,
    };
  }
  return read;
}

/**
 * How many times a check is repeated inside one window.
 *
 * Ten because the miss this exists for was measured at one in ten (2026-08-22,
 * `docs/experiments/2026-08-21-customer-feedback.md`), and a rate of one in ten
 * cannot be seen at all in fewer. The repeats are INSIDE the window on purpose:
 * repeating the whole stage five times would cost five window launches and buy
 * the same number.
 */
const ATTEMPTS = 10;

/**
 * How long the editor is given to grow a group, before the attempt is a miss.
 *
 * By event with a ceiling, not by sleep -- but a MISS is the absence of an
 * event, so a ceiling is the only thing that can end the wait. Two seconds
 * against a measured 6 to 83 ms for a call that works, in both editors: two
 * orders of magnitude of room, so that a slow machine cannot manufacture a miss.
 */
const GROWS_WITHIN_MS = 2000;

/** How long the editor area is given to come back to one group between attempts. */
const RESETS_WITHIN_MS = 1000;

function groups() {
  return vscode.window.tabGroups.all.length;
}

/**
 * Waits until the number of tab groups is no longer `from`, or the ceiling.
 *
 * @param {number} from the count to wait to move away from
 * @param {number} ms the ceiling
 * @returns {Promise<boolean>} whether it moved
 */
function moved(from, ms) {
  return new Promise((resolve) => {
    if (groups() !== from) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      subscription.dispose();
      resolve(groups() !== from);
    }, ms);
    const subscription = vscode.window.tabGroups.onDidChangeTabGroups(() => {
      if (groups() !== from) {
        clearTimeout(timer);
        subscription.dispose();
        resolve(true);
      }
    });
  });
}

/**
 * One check, repeated, as a record for the judge.
 *
 * @param {string} check the name the budget bounds it by
 * @param {() => Promise<{grew: boolean, before: number, after: number, threw: string | null, ms: number}>} attempt
 * @returns {Promise<{check: string, attempts: number, misses: number, tries: unknown[]}>}
 */
async function repeated(check, attempt) {
  const tries = [];
  for (let number = 1; number <= ATTEMPTS; number += 1) {
    // A sequence and not a set: each attempt starts from the editor area the
    // one before it left, so they cannot be awaited together.
    tries.push({ attempt: number, ...(await attempt()) });
  }
  return { check, attempts: ATTEMPTS, misses: tries.filter((one) => !one.grew).length, tries };
}

const measured = [];

suite('the fork`s workbench', () => {
  suiteTeardown(() => {
    if (OUT === undefined) {
      return;
    }
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(
      OUT,
      `${JSON.stringify(
        {
          kind: 'cursor-rate',
          // 2 since 2026-08-26: `workbench` is here, and a record without it is
          // a rate with no subject. `tools/gate.mjs` refuses to judge one.
          version: 2,
          // The build read from the editor's own product.json, and the version
          // its API answers. Both, because in a fork they differ.
          build: BUILD === undefined ? null : JSON.parse(BUILD),
          appName: vscode.env.appName,
          apiVersion: vscode.version,
          // Which workbench answered, and the two readings it was decided from
          // -- the raw ones, so that whoever opens this in a month can count
          // again instead of believing the word next to them. The directory is
          // named rather than pathed: it lives under the profile the runner
          // handed this window, `.vscode-test/user-data-cursor/logs/`.
          workbench: workbench(),
          recordedAt: new Date().toISOString(),
          notMeasured: [
            'the product: nothing in this file exercises Gripterm, and that is a choice rather than the ' +
              'fork`s doing. Measured 2026-08-25 over 33 launches: only a GLASS window of Cursor refuses ' +
              'third-party extensions (48 entries in `vscode.extensions.all` against 113 outside glass), ' +
              // Read from THIS run rather than asserted about every run. The
              // sentence here until 2026-08-26 said "and the window this stage
              // opens is not a glass one" -- a standing claim about a window
              // nothing was reading, which printed unchanged out of a glass run
              // the day the reading was added and was false in it.
              'and the window THIS run opened was the "' + workbench().is + '" one. What covers the ' +
              'product in Cursor is `pnpm run test:stand`, which uses a dev host.',
          ],
          checks: measured,
        },
        null,
        2
      )}\n`,
      'utf8'
    );
  });

  /**
   * The customer's defect number 6, as the editor rather than as the product.
   *
   * `workbench.action.newGroupBelow` over an editor area holding one empty
   * group is what the extension asks for when it makes the strip. Measured
   * 2026-08-22 on Cursor: it did nothing at all on one call in ten, and in a
   * separate run it threw `Invalid editor group provided!` from inside the
   * workbench. `column()` believed it, read the ACTIVE group -- which after a
   * miss is the person's own -- and locked it, and the terminals filled the
   * screen. That is the complaint, word for word.
   *
   * VS Code 1.134.0 does not do this: 15 of 15 that day, 10 of 10 on
   * 2026-08-25. The difference between the editors is the whole subject.
   */
  test('makes a group below, over an editor area holding one empty group', async function () {
    this.timeout(ATTEMPTS * (GROWS_WITHIN_MS + RESETS_WITHIN_MS) + 30000);

    const found = await repeated('cursor-newGroupBelow', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllGroups');
      await moved(groups() + 1, RESETS_WITHIN_MS);
      const before = groups();
      const started = Date.now();
      let threw = null;
      try {
        await vscode.commands.executeCommand('workbench.action.newGroupBelow');
      } catch (refused) {
        // The workbench refusing out loud and the workbench doing nothing in
        // silence are one miss each. They are told apart in the record because
        // they were told apart in the measurement: on 2026-08-22 the fork did
        // both, and only one of them left anything to read.
        threw = refused instanceof Error ? refused.message : String(refused);
      }
      const grew = threw === null && (await moved(before, GROWS_WITHIN_MS));
      return { before, after: groups(), grew, threw, ms: Date.now() - started };
    });

    measured.push(found);

    // The numbers are kept whatever workbench this turned out to be -- 10 of 10
    // in glass is a real measurement of a real window -- and they are ASSERTED
    // on only in the one they belong to. In any other, this test is PENDING,
    // which is Mocha's word for the third answer: not passed, not failed, not
    // measured. Saying "10 misses of 10" here would name a defect of the product
    // for a run that opened a different window, which is the whole defect Ш19
    // exists for.
    const bench = workbench();
    if (bench.is !== CLASSIC) {
      this.skip();
    }

    // For a person running this by hand. The gate reads the FILE, because this
    // host's exit code is a coin -- 1, 0, 0, 1 over four identical consecutive
    // launches, measured 2026-08-25. (This comment said "is 0 whatever happens
    // here" until 2026-08-26, which is the claim those 33 launches refuted and
    // which the head of this file has said so since. It is one of the nine
    // places that sentence was copied to.)
    assert.equal(
      found.misses,
      0,
      `${found.check}: ${String(found.misses)} of ${String(found.attempts)} attempts made no group below`
    );
  });

  /**
   * Which workbench answered -- red when this run cannot say, and it costs a
   * colour on purpose.
   *
   * Last on purpose, so that the reading behind it is taken as late as the suite
   * allows: the `"layout":"glass"` line is written by the fork's own extension,
   * and the more of the window's life has happened, the more of that log exists.
   *
   * It is the acceptance of Ш19 and it is red today only if the window changed:
   *
   *     GRIPTERM_CURSOR_GLASS=1 npx vscode-test --label cursor
   *
   * asks for the other workbench by hand, which is the one way to see this fail
   * without waiting for the fork to change under us. The gate never asks.
   */
  test('says which workbench of the fork it measured, and can prove which', () => {
    const bench = workbench();

    assert.equal(
      bench.is,
      CLASSIC,
      `this run measured the "${bench.is}" workbench, not the "${CLASSIC}" one these ceilings were measured in. ` +
      `${bench.because}`
    );
  });
});
