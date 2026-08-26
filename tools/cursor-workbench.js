'use strict';

const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

/**
 * Which WORKBENCH of the fork a run was measured in, read out of its own logs.
 *
 * **Why this exists.** Cursor opens a window in one of two workbenches -- its
 * own `glass`, or the ordinary one -- and no API says which. The difference is
 * the whole subject of the Cursor strip: measured 2026-08-25 over 33 launches
 * driving `Cursor.exe` directly, `workbench.action.newGroupBelow` over an empty
 * editor area missed 10 attempts of 10 in a glass window (5 launches of 5, every
 * miss a throw of `Invalid editor group provided!`) and 0 of 10 outside glass
 * (12 launches of 12 under `--classic`, 6 of 6 with a folder and no flag). The
 * same command, the same build, the same minute.
 *
 * Which one the gate's stage gets is decided today by an argument that is there
 * for something else. Commit `6078beb` gave the label a folder to open, for
 * `newGroupBelow`; a path on the command line makes the fork's
 * `hasExplicitFirstWindowIntent` true, so no decision about the first window is
 * taken, and on a fresh profile -- which every gate run is -- that decision is
 * the only thing that turns glass on. Drop the folder, or let the fork change
 * how it reads its command line, and the stage measures the OTHER workbench
 * without a word: 10 misses of 10, a red gate, and a person spending a day on a
 * defect of the product that is a fact about a window.
 *
 * **Two signals, because one is one point of being wrong.** A glass window names
 * its per-window log directory `window1_wb0` -- workbench 0 of a multi-workbench
 * window -- where an ordinary one names it `window1`; and the fork's own
 * extension writes `"layout":"glass"` into a structured log beside it. Both were
 * PREDICTED and then measured on 2026-08-25: the prediction "no folder and no
 * flag gives glass, 48 extensions, ours absent, 10 misses of 10" came back
 * `window1_wb0`, 68 mentions, 48, absent, 10 of 10. Where they disagree this
 * answers `unknown`, which is a colour and not a guess -- the same choice the
 * gate already makes about a missing `rate.json`, which is RED and never silence.
 *
 * **The asymmetry between the two readings is deliberate.** A mention FOUND is
 * evidence whatever else went unread; a mention NOT found is evidence only about
 * the files that were actually opened, so `unreadable` is counted and nought
 * mentions across nought readable files establishes nothing. That is the same
 * defect as `grep ... || echo 0`, which printed nought both for no matches and
 * for no file, and put a false claim into a commit of this repository.
 *
 * **CommonJS, and on purpose.** Three module systems read it: `tools/gate.mjs`
 * is ESM, `tests/cursor/new-group-below.js` is a Mocha file handed straight to
 * an extension host with nothing compiling it, and `tests/cursor/workbench.test.ts`
 * is a Jest suite. The same arrangement, for the same reason, as
 * `tools/fork-build.js` and `tools/what-fell.js`.
 *
 * Run by hand, it prints the reading for a profile:
 * `node tools/cursor-workbench.js .vscode-test/user-data-cursor`
 */

/** The fork's word for the workbench it refuses third-party extensions in. */
const GLASS = 'glass';

/** The fork's own word for the other one -- it is what `--classic` asks for. */
const CLASSIC = 'classic';

/** Neither reading, or two readings that disagree. Never a guess at the third. */
const UNKNOWN = 'unknown';

/** How a glass window names its per-window log directory: workbench N of a window. */
const A_GLASS_WINDOW = /^window\d+_wb\d+$/u;

/** How an ordinary window names it. */
const AN_ORDINARY_WINDOW = /^window\d+$/u;

/** What the fork's own extension writes into its structured log in a glass window. */
const THE_LINE = '"layout":"glass"';

/**
 * What the newest launch under a profile left behind, as numbers.
 *
 * The NEWEST and not all of them: a profile is reused across runs, and the
 * question is about the window that just ran. The directories are named by the
 * second the editor started, so sorting them by name sorts them by time.
 *
 * @param {string} userData the profile directory the run was given
 * @returns {{at: string | null, windows: string[], logFiles: number, unreadable: number, glassMentions: number}}
 */
function readWorkbench(userData) {
  const nothing = { at: null, windows: [], logFiles: 0, unreadable: 0, glassMentions: 0 };
  const logs = join(userData, 'logs');
  if (!existsSync(logs)) {
    return nothing;
  }
  const launches = readdirSync(logs).filter((name) => statSync(join(logs, name)).isDirectory());
  if (launches.length === 0) {
    return nothing;
  }
  const at = launches.sort()[launches.length - 1];
  const root = join(logs, at);

  let logFiles = 0;
  let unreadable = 0;
  let glassMentions = 0;
  /** @param {string} where @returns {void} */
  const walk = (where) => {
    for (const name of readdirSync(where)) {
      const full = join(where, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (name.endsWith('.log')) {
        logFiles += 1;
        try {
          glassMentions += readFileSync(full, 'utf8').split(THE_LINE).length - 1;
        } catch {
          // A log the editor is holding open is a log this could not read, and
          // that is a different fact from a log with no mention in it. Counted
          // rather than swallowed: `whichWorkbench` refuses to read nought
          // mentions across nought readable files as "not glass".
          unreadable += 1;
        }
      }
    }
  };
  walk(root);

  return {
    at,
    windows: readdirSync(root).filter(
      (name) => name.startsWith('window') && statSync(join(root, name)).isDirectory()
    ),
    logFiles,
    unreadable,
    glassMentions,
  };
}

/**
 * The workbench those readings name, or `unknown`.
 *
 * Pure, and separate from the reading, so that the cases a real profile cannot
 * be made to produce on demand -- a log held open by the very process writing it
 * -- are cases a test can still state.
 *
 * @param {{at: string | null, windows: readonly string[], logFiles: number, unreadable: number, glassMentions: number}} readings
 * @returns {{is: string, because: string}}
 */
function whichWorkbench(readings) {
  const read = readings.logFiles - readings.unreadable;
  const what =
    `the newest launch (${readings.at ?? 'none found'}) left window directories ` +
    `[${readings.windows.length === 0 ? 'none' : readings.windows.join(', ')}], and ${THE_LINE} appears ` +
    `${String(readings.glassMentions)} time(s) in the ${String(read)} log file(s) read of ` +
    `${String(readings.logFiles)} found`;

  const byName = nameSays(readings.windows);
  const byLog = readings.glassMentions > 0 ? GLASS : read > 0 ? CLASSIC : null;

  if (byName === null && byLog === null) {
    return { is: UNKNOWN, because: `neither reading was available: ${what}` };
  }
  if (byName === null || byLog === null) {
    return {
      is: UNKNOWN,
      because:
        `only one of the two readings was available (${byName ?? byLog ?? UNKNOWN}), and one reading is one ` +
        `point of being wrong: ${what}`,
    };
  }
  if (byName !== byLog) {
    return {
      is: UNKNOWN,
      because: `the two readings disagree -- the window directory says ${byName} and the logs say ${byLog}: ${what}`,
    };
  }
  return { is: byName, because: `both readings say ${byName}: ${what}` };
}

/**
 * Which workbench the window directories name, or `null` for "they do not".
 *
 * A shape belonging to neither is `null` rather than "the ordinary one": the day
 * the fork renames these, a reader must be told it stopped reading rather than
 * told the answer it used to get.
 *
 * @param {readonly string[]} windows the per-window directories of one launch
 * @returns {string | null}
 */
function nameSays(windows) {
  if (windows.length === 0) {
    return null;
  }
  if (windows.some((name) => A_GLASS_WINDOW.test(name))) {
    return GLASS;
  }
  return windows.every((name) => AN_ORDINARY_WINDOW.test(name)) ? CLASSIC : null;
}

/**
 * The answer and the readings it was made from, for a record somebody keeps.
 *
 * Both, because a conclusion nobody can recount is a claim. Whoever opens the
 * record a month from now gets the two numbers and the directory they came out
 * of, and can go and count again.
 *
 * @param {string} userData the profile directory the run was given
 * @returns {{is: string, because: string, read: object}}
 */
function workbenchOf(userData) {
  const read = readWorkbench(userData);
  return { ...whichWorkbench(read), read };
}

module.exports = { CLASSIC, GLASS, UNKNOWN, readWorkbench, whichWorkbench, workbenchOf };

if (require.main === module) {
  const userData = process.argv[2];
  if (userData === undefined) {
    process.stderr.write('usage: node tools/cursor-workbench.js <user-data-dir>\n');
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(workbenchOf(userData), null, 2)}\n`);
}
