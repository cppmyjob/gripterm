'use strict';

const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const assert = require('node:assert');
const vscode = require('vscode');

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
 * **What this stage therefore does NOT cover, said here as well as in the
 * gate's own list:** the product, in Cursor, under a test host. Nothing here
 * EXERCISES Gripterm -- and since 2026-08-25 that is no longer the same sentence
 * as "nothing here loads it". Measured from the gate's own logs that day, the
 * window this label opens is not a glass one (its log directory is `window1`,
 * not `window1_wb0`, and holds no `"layout":"glass"` line), and a window that is
 * not glass registers our extension. Whether THIS window has it in
 * `extensions.all` has never been asked, because nothing here asks. What covers
 * the product in Cursor is `pnpm run test:stand`, which uses a DEV host -- no
 * `--extensionTestsPath` -- where the extension does load, measured the same day.
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
          version: 1,
          // The build read from the editor's own product.json, and the version
          // its API answers. Both, because in a fork they differ.
          build: BUILD === undefined ? null : JSON.parse(BUILD),
          appName: vscode.env.appName,
          apiVersion: vscode.version,
          recordedAt: new Date().toISOString(),
          notMeasured: [
            'the product: nothing in this file exercises Gripterm, and that is a choice rather than the ' +
              'fork`s doing. Measured 2026-08-25 over 33 launches: only a GLASS window of Cursor refuses ' +
              'third-party extensions (48 entries in `vscode.extensions.all` against 113 outside glass), ' +
              'and the window this stage opens is not a glass one. What covers the product in Cursor is ' +
              '`pnpm run test:stand`, which uses a dev host.',
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
    // For a person running this by hand. The gate reads the file, because this
    // host's exit code is 0 whatever happens here.
    assert.equal(
      found.misses,
      0,
      `${found.check}: ${String(found.misses)} of ${String(found.attempts)} attempts made no group below`
    );
  });
});
