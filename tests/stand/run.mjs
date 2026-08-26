/*
 * The two-sitting stand, run rather than described.
 *
 * It opens and closes a real editor several times over ONE project folder and
 * asks whether the window a person comes back to is the window they left. The
 * defect it exists for does not show in a single sitting: measured on
 * 2026-08-23, seven sittings over one folder went 2, 2, 4, 5, 6, 7, 8 editor
 * groups, and the second of them was clean.
 *
 * **Two halves, and only this one needs a machine.** This file and
 * `observer/extension.js` MEASURE: they start the editor, write down what the
 * editor area looked like, and close the window again. `judge.ts` JUDGES, and it
 * is a function from a recording to a verdict -- which is why "the stand goes
 * red on the staircase" and "the stand goes green on a healthy window" are both
 * checked by `npx jest tests/stand`, in under a second, with no editor at all.
 * Without the second of those two, a stand that is red unconditionally passes
 * the first.
 *
 * **What it will not touch.** Every window this starts carries a
 * `--user-data-dir`, an `--extensions-dir` and a `gripterm.storage.path` of its
 * own, all three under `.vscode-test/`. The store the person who owns this
 * machine keeps their terminals in is never opened, and the run refuses to start
 * if the path it is about to hand over is not one of ours.
 *
 * **What it closes.** Only windows that did not exist when it started. The pids
 * are taken before each sitting is launched and the difference is what gets
 * `CloseMainWindow()` -- not a filter on the command line, which breaks the day
 * somebody opens a second copy with the same user data directory, and not a kill
 * by name, which would close the window the owner is working in. Both of those
 * readings are still a list of WINDOWS, asked of PowerShell; what changed on
 * 2026-08-26 is only the WAIT after the asking, which watches the pid it already
 * knows rather than enumerating windows again. Measured that day over four
 * sittings: the process outlives its window by 507 to 1040 ms, against a ceiling
 * of 60 000.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostUserData, runStore } from '../../tools/host-user-data.mjs';
import { refuseStaleBuilds } from '../../tools/refuse-stale-builds.mjs';

const require = createRequire(import.meta.url);

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const LABEL = 'stand';

/**
 * When this run started, and therefore the name its trace is kept under if it
 * turns out to be one worth keeping.
 *
 * Read once, at the top, rather than when the trace is written: a run that died
 * has to be named by when it BEGAN, like every other, or two runs sort in the
 * wrong order the day one of them takes twelve minutes and the next one three
 * seconds.
 */
const STARTED_AT = new Date();

// CommonJS, and required rather than imported, because three module systems
// need this one function: this file and `.vscode-test.mjs` are ESM, and its own
// suite is Jest. See the head of `tools/fork-build.js`.
const { forkBuild } = require(join(REPO, 'tools', 'fork-build.js'));
/*
 * Everything this file asks the operating system, and the count of what it
 * started in order to ask. CommonJS for the same reason as the line above.
 *
 * The module exists because on 2026-08-26 a full gate died HERE, in the fourth
 * sitting, because Windows would not make another `powershell.exe`
 * (`0xC0000142`, and no verdict at all). MEASURED that day: a whole run started
 * twenty of them, five per sitting. Four of the five are the edges of a sitting,
 * where the question really is about a WINDOW; the fifth was the close-wait,
 * which now asks whether a pid is still running and starts nothing. Sixteen
 * chances of being refused are not meaningfully better than twenty, so the same
 * module also asks again when it is refused -- see `ASKED_AGAIN` there.
 */
const {
  closeWindow,
  editorWindows,
  lost,
  opened,
  powershellRuns,
  waitUntilGone,
  windowsAmong,
} = require(join(REPO, 'tools', 'editor-windows.js'));
const BASE = join(REPO, '.vscode-test');
const STORE = runStore(LABEL);
const EXTENSIONS = join(BASE, `extensions-${LABEL}`);
const OUTPUT = join(BASE, `${LABEL}-output`);
const PROJECT = join(BASE, `${LABEL}-project`);
const USER_DATA = join(BASE, `user-data-${LABEL}`);
/** Where the trace of a run that was not green is kept, and where `prepare()` deliberately does not reach. */
const KEEPSAKES = join(BASE, `${LABEL}-red`);

/**
 * The directories one run works in, as one object.
 *
 * Handed to `tests/stand/keepsake.ts` whole, so that the emptying and the
 * keeping cannot disagree about a path: what a run deletes before it starts and
 * what it copies aside when it ends are two readings of THIS.
 */
const PLACES = { base: BASE, userData: USER_DATA, store: STORE, output: OUTPUT, keepsakes: KEEPSAKES };

/*
 * Compiled TypeScript, and required rather than imported for the same reason the
 * judge is (see the verdict, at the end of this file).
 *
 * Required HERE and not down there because `prepare()` needs half of it before
 * the first window opens: the list of directories a run empties is stated in
 * that module, so that `keepsake.test.ts` can check "a kept trace survives the
 * next run" by deleting the list the next run really deletes, rather than its
 * own copy of it.
 */
const { KEPT_TRACES, LOUD_ABOVE_BYTES, keepRun, runDirectories } =
  require(join(REPO, 'out', 'tests', 'stand', 'keepsake.js'));
const PRODUCT = join(REPO, 'packages', 'extension');
const OBSERVER = join(REPO, 'tests', 'stand', 'observer');
const RECORDING = join(OUTPUT, 'recording.ndjson');
/**
 * The verdict, as JSON, for whoever has to do arithmetic on it.
 *
 * An exit code says red or green and nothing else, and `tools/gate.mjs` has to
 * ask a harder question: which points were red, by how much, and is that exactly
 * what `gate/allowed-red.json` admits. It is written HERE rather than recomputed
 * there, so that the gate judges the run that happened -- and it lands inside
 * `OUTPUT`, which `prepare()` deletes at the start of every run, so a gate
 * cannot read yesterday's answer as today's.
 */
const VERDICT = join(OUTPUT, 'verdict.json');

/**
 * How many times the stand sits down, and how many terminals the first sitting
 * makes.
 *
 * Four because three is the fewest that can answer the question at all
 * (`judge.ts`, `BUDGET.sittings`) and the measured staircase first stepped at
 * the third: a run that stopped there would rest the whole verdict on one step.
 */
const SITTINGS = 4;
const TERMINALS = 2;

/** How long one sitting is given, from the editor being spawned to the observer signalling. */
const SITTING_WITHIN_MS = 240_000;
/** How long a window is given to be gone after it was asked to close. */
const CLOSES_WITHIN_MS = 60_000;
const POLL_MS = 500;

/** How the lines of a recording are told apart, wherever it was written. */
const NEWLINE = /\r?\n/u;

/**
 * The editors this looks for, in this order.
 *
 * Cursor first because the staircase is a Cursor measurement and the person who
 * reported it works there; VS Code is the fallback, and which one answered is
 * written into the recording rather than assumed by whoever reads it. Neither is
 * downloaded: this run wants the editor a person actually uses, not the copy
 * `@vscode/test-electron` unpacks.
 */
const EDITORS = [
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'cursor', 'Cursor.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
];

function step(what) {
  console.log(`\n=== ${what}`);
}

async function until(what, ready, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const answer = ready();
    if (answer !== null) {
      return answer;
    }
    if (Date.now() > deadline) {
      throw new Error(`gave up waiting for ${what} after ${String(ms)} ms`);
    }
    await new Promise((wake) => setTimeout(wake, POLL_MS));
  }
}

/** The records in the stand's own store, with what the judge reads of each. */
function records() {
  const directory = join(STORE, 'terminals');
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory).flatMap((id) => {
    const file = join(directory, id, 'record.json');
    if (!existsSync(file)) {
      return [];
    }
    const record = JSON.parse(readFileSync(file, 'utf8'));
    const trace = join(directory, id, 'starts.jsonl');
    const starts = existsSync(trace)
      ? readFileSync(trace, 'utf8')
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
      : [];
    return [{
      id,
      // `order` on disk, `placement` in the recording, and the two names are the
      // product's own: `TerminalEntry.placement` is `order ?? createdAt`, and it
      // is what both the tabs and the rows are sorted by. A record nobody has
      // dragged has no `order`, so this is `null` far more often than not -- and
      // that is a fact about the store rather than a gap in the measurement.
      placement: record.order ?? null,
      createdAt: record.createdAt ?? null,
      starts: starts.map((one) => ({ what: one.what, intent: one.intent ?? null })),
    }];
  });
}

/** What each sitting's own starts are, told apart from the sitting before it. */
function startsSince(before) {
  const seen = new Map(before.map((one) => [one.id, one.starts.length]));
  return records().map((one) => ({ ...one, starts: one.starts.slice(seen.get(one.id) ?? 0) }));
}

// --- getting ready ----------------------------------------------------------

function theEditor() {
  const named = process.env.GRIPTERM_STAND_EDITOR;
  if (named !== undefined && named.length > 0) {
    if (!existsSync(named)) {
      throw new Error(`GRIPTERM_STAND_EDITOR names ${named}, and there is nothing there`);
    }
    return named;
  }
  const found = EDITORS.find((one) => existsSync(one));
  if (found === undefined) {
    throw new Error(
      `no editor to run the stand in: none of ${EDITORS.join(', ')} exists. ` +
        'Set GRIPTERM_STAND_EDITOR to the .exe of the one to use.'
    );
  }
  return found;
}

/**
 * Whether what is on disk under `.vscode-test` belongs to THIS run yet.
 *
 * It decides one thing and it is not a detail: a run that dies before this is
 * true died over the FILES OF THE RUN BEFORE IT, and keeping those under this
 * run's name would be a trace that lies about whose they are. See `keep`.
 */
let ownDirectoriesMade = false;

/**
 * The directories, and the one refusal that stands in front of the whole run.
 *
 * The store is emptied and the project folder is NOT. Both halves matter and
 * neither is a detail:
 *
 *   * a run that inherited yesterday's records would be judging a restore of
 *     terminals nobody made today;
 *   * the editor keys everything it remembers about a window -- the grid
 *     included -- by a workspace storage id derived from the folder. A folder
 *     made afresh between sittings gets a new one, every sitting opens a virgin
 *     window, and the stand reports that nothing accumulates. That is the trap
 *     `tests/acceptance/run.mjs` sits in, and the reason `judge.ts` asserts the
 *     key rather than trusting this comment.
 */
function prepare() {
  const store = resolve(STORE);
  if (!store.startsWith(resolve(BASE))) {
    throw new Error(
      `this run would have pointed the product at ${store}, which is not under ${BASE}. ` +
        'The store a stand opens is the store it may write in, and that is not one of ours.'
    );
  }

  // The three, by the same list the trace of a red run is checked against, and
  // each of them refused by `under()` in exactly the way the store is refused
  // above. `${LABEL}-red` is deliberately not among them: what was kept of a run
  // that went red is the one thing here the next run does not take away.
  for (const directory of runDirectories(PLACES)) {
    rmSync(directory, { recursive: true, force: true });
  }
  mkdirSync(OUTPUT, { recursive: true });
  mkdirSync(EXTENSIONS, { recursive: true });

  if (!existsSync(PROJECT)) {
    mkdirSync(PROJECT, { recursive: true });
  }
  for (const [name, body] of [
    ['README.md', '# the project of the two-sitting stand\n\nOpened over the strip in the last sitting.\n'],
    ['design.md', '# a second file, so that the window has something in it that is not ours\n'],
  ]) {
    const file = join(PROJECT, name);
    if (!existsSync(file)) {
      writeFileSync(file, body, 'utf8');
    }
  }

  const userData = hostUserData(LABEL, {
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'workbench.startupEditor': 'none',
    // `window.restoreWindows` is deliberately NOT set. Measured 2026-08-21: it
    // has nothing to do with the grid coming back when a folder is open, and a
    // stand that set it would be measuring its own setting.
  });
  ownDirectoriesMade = true;
  return userData;
}

/**
 * The trace of this run: kept if it was not green, and said out loud either way.
 *
 * The colour is known only here, which is why nothing about keeping happens in
 * `prepare()`: at the start of a run there is no verdict for anyone to read.
 * `died` is passed for a run that stopped before there was a verdict, and it is
 * kept exactly as a red one is -- "no verdict" must never end up looking like
 * "green".
 */
function keep(outcome) {
  let kept;
  try {
    kept = keepRun(PLACES, outcome, STARTED_AT);
  } catch (failed) {
    // Keeping the trace of a failure must never replace the failure. If the
    // copying cannot be done, it says so and the run reports what it came to
    // report.
    console.log(`\nthe trace of this run could not be kept: ${failed.message}`);
    return;
  }
  if (kept === null) {
    console.log(`\ngreen -- nothing of this run kept, and nothing taken out of ${KEEPSAKES}`);
    return;
  }
  const nothingFor = kept.missing.length === 0 ? '' : `   (nothing to copy for: ${kept.missing.join(', ')})`;
  const tookAway = kept.removed.length === 0 ? '' : `, after taking away ${kept.removed.join(', ')}`;
  console.log(`\nthis run is kept at ${kept.at}`);
  console.log(`  copied   : ${kept.copied.join(', ')}${nothingFor}`);
  console.log(`  kept now : ${String(kept.traces)} run(s), ${megabytes(kept.keptBytes)}${tookAway}`);
  if (kept.keptBytes > LOUD_ABOVE_BYTES) {
    console.log(
      `  READ THIS: ${String(KEPT_TRACES)} traces now come to ${megabytes(kept.keptBytes)}, past the ` +
        `${megabytes(LOUD_ABOVE_BYTES)} that number was chosen under. A bound on COUNT stops bounding bytes ` +
        'the day one trace grows -- see KEPT_TRACES in tests/stand/keepsake.ts and pick again.'
    );
  }
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Whether the close-wait also watches the WINDOW go, at a whole `powershell.exe`
 * per poll, beside the process it is actually waiting on.
 *
 * Off, and the flag is here rather than deleted because it is the instrument
 * that CHOSE the wait. "The window is gone" and "the process is gone" are two
 * events, and moving the wait from the first to the second is only honest if
 * somebody has measured the gap -- so the measurement stays runnable:
 *
 *     GRIPTERM_STAND_WATCH_WINDOWS=yes pnpm run test:stand
 *
 * Its answer on 2026-08-26 is in the report of the day and in the comment on
 * `waitUntilGone`.
 */
const WATCH_WINDOWS_TOO = process.env.GRIPTERM_STAND_WATCH_WINDOWS === 'yes';

/** One window's departure, in whichever of the two senses were watched. */
function wentAway(one) {
  const process_ = one.afterMs === null ? 'never' : `${String(one.afterMs)} ms`;
  if (!WATCH_WINDOWS_TOO) {
    return `${process_} (the process)`;
  }
  const window_ = one.alsoAfterMs === null ? 'never' : `${String(one.alsoAfterMs)} ms`;
  return `${window_} (the window), ${process_} (the process)`;
}

// --- one sitting ------------------------------------------------------------

async function sitting(number, editor, userData) {
  const done = join(OUTPUT, `done-${String(number)}.json`);
  rmSync(done, { force: true });
  const before = editorWindows();
  const seen = records();
  console.log(`--- sitting ${String(number)}`);
  console.log(`  windows that must survive : ${before.join(', ') || 'none'}`);

  const started = Date.now();
  const window = spawn(
    editor,
    [
      `--extensionDevelopmentPath=${PRODUCT}`,
      `--extensionDevelopmentPath=${OBSERVER}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${EXTENSIONS}`,
      '--disable-workspace-trust',
      '--new-window',
      PROJECT,
    ],
    {
      stdio: 'ignore',
      detached: false,
      env: {
        ...process.env,
        GRIPTERM_STAND_LOG: RECORDING,
        GRIPTERM_STAND_SITTING: String(number),
        GRIPTERM_STAND_DONE: done,
        GRIPTERM_STAND_PROJECT: PROJECT,
        GRIPTERM_STAND_MAKE: String(number === 1 ? TERMINALS : 0),
        GRIPTERM_STAND_OPEN_A_FILE: number === SITTINGS ? 'yes' : 'no',
      },
    }
  );
  window.unref();

  const signal = await until(
    `sitting ${String(number)} to signal that it had settled`,
    () => (existsSync(done) ? JSON.parse(readFileSync(done, 'utf8')) : null),
    SITTING_WITHIN_MS
  );
  console.log(`  settled after            : ${String(Date.now() - started)} ms`);

  const mine = opened(before, editorWindows());
  console.log(`  closing only             : ${mine.join(', ') || 'none'}`);
  for (const pid of mine) {
    closeWindow(pid);
  }
  const closing = await waitUntilGone(mine, {
    withinMs: CLOSES_WITHIN_MS,
    pollMs: POLL_MS,
    also: WATCH_WINDOWS_TOO ? windowsAmong : null,
  });
  for (const one of closing.gone) {
    console.log(`  ${String(one.pid)} gone after              : ${wentAway(one)}`);
  }

  const survivors = editorWindows();
  const takenDown = lost(before, survivors);
  if (takenDown.length > 0) {
    throw new Error(
      `this sitting closed ${takenDown.join(', ')}, which existed before it started. ` +
        'Those are somebody else`s windows and the run stops here.'
    );
  }

  keyIsReal(number, userData);

  return {
    kind: 'sitting',
    sitting: number,
    restoredMs: signal.restoredMs ?? null,
    records: startsSince(seen),
  };
}

/**
 * That the key the observer wrote down names a directory the editor really keeps
 * this folder's memory in.
 *
 * The measurement checking itself, and it exists because the first run of this
 * stand got it wrong: `storageUri` ends in the EXTENSION's identity, so the key
 * recorded was the same string in every window ever opened and point 0 was green
 * about a constant. A key that names nothing on disk is that mistake again.
 */
function keyIsReal(number, userData) {
  const keys = [...new Set(
    recorded()
      .filter((one) => one.kind === 'snapshot' && one.sitting === number)
      .map((one) => one.workspaceStorage)
      .filter((key) => typeof key === 'string')
  )];
  if (keys.length === 0) {
    throw new Error(`sitting ${String(number)} never read the editor's key for this folder`);
  }
  const kept = join(userData, 'User', 'workspaceStorage');
  for (const key of keys) {
    if (!existsSync(join(kept, key))) {
      throw new Error(
        `sitting ${String(number)} wrote down ${JSON.stringify(key)} as the editor's key for this ` +
          `folder, and there is no ${join(kept, key)}. The observer is reading the wrong ` +
          'segment of `context.storageUri`, and point 0 would be green about a constant.'
      );
    }
  }
}

/** Everything written into the recording so far, as objects. */
function recorded() {
  return readFileSync(RECORDING, 'utf8')
    .split(NEWLINE)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// --- the run ----------------------------------------------------------------

async function main() {
  // Before anything is launched: a host given a bundle older than its source
  // measures code nobody wrote today and says green about it.
  refuseStaleBuilds();

  const editor = theEditor();
  const userData = prepare();
  step(`the stand sits down ${String(SITTINGS)} times in ${editor}`);
  console.log(`  project   : ${PROJECT}   (made once, never remade)`);
  console.log(`  user data : ${userData}`);
  console.log(`  store     : ${STORE}`);
  console.log(`  recording : ${RECORDING}`);

  writeFileSync(
    RECORDING,
    `${JSON.stringify({
      kind: 'stand',
      version: 1,
      what: `${String(SITTINGS)} sittings over one project folder, opened and closed by tests/stand/run.mjs`,
      // The name of the editor and not the path to it: the path names whoever
      // owns this machine, and a recording is a file that gets committed,
      // pasted into a report and sent to somebody. The full path is printed
      // above, where the person running it is the only reader.
      // `tests/stand/no-machine-in-the-record.test.ts` holds this line, and the
      // observer's `neutral`, over the recordings rather than over the comment.
      editor: basename(editor),
      /*
       * WHICH BUILD of it, which the line above cannot say and which every
       * question this recording is evidence for turns out to need.
       *
       * The stand measures a WORKBENCH, and the workbench of a fork ships every
       * few days. `gate/allowed-red.json` explains a point with a sentence read
       * out of the "Cursor 3.17.8 bundle"; the Cursor that answered this run is
       * 3.17.19, published two days after that sentence was written; and until
       * now the recordings said `Cursor.exe` and stopped. So two runs that
       * disagree could not be told apart from one run whose editor moved under
       * it -- and on 2026-08-25 that is not hypothetical: the same probe
       * measured `newGroupBelow` at 9 of 10 on one day and 10 of 10 on another,
       * with both the folder and the build different between them, and nothing
       * written down that separates the two.
       *
       * Read from the editor's own `product.json` and neutral by construction:
       * five fields, no path. `tools/fork-build.js` holds that.
       */
      build: forkBuild(editor),
      recordedAt: new Date().toISOString(),
      derivedFrom: ['nothing -- every line after this one was written by the observer inside the window, or by the runner after it closed'],
      notMeasured: [
        'whether the button is visible and what colour its icon is: no editor API answers either',
      ],
    })}\n`,
    'utf8'
  );

  for (let number = 1; number <= SITTINGS; number += 1) {
    const summary = await sitting(number, editor, userData);
    writeFileSync(RECORDING, `${JSON.stringify(summary)}\n`, { flag: 'a', encoding: 'utf8' });
    if (number === 1 && summary.records.length === 0) {
      throw new Error(
        `sitting 1 left no record in ${STORE}. Either no terminal was made, or the ` +
          'setting `gripterm.storage.path` never reached the window -- and a sitting ' +
          'that wrote its records somewhere else is one this run must not judge.'
      );
    }
  }

  step('the verdict');
  // The judge is compiled TypeScript, from `tsconfig.stand.json`. Required
  // rather than imported so that the CommonJS the compiler emits is loaded as
  // the CommonJS it is, with no guessing about what a named export becomes.
  const { BUDGET, judge } = require(join(REPO, 'out', 'tests', 'stand', 'judge.js'));
  const { parseRecording } = require(join(REPO, 'out', 'tests', 'stand', 'recording.js'));
  const verdict = judge(parseRecording(readFileSync(RECORDING, 'utf8')), BUDGET);
  for (const finding of verdict.findings) {
    console.log(`  ${String(finding.point)}. ${finding.answer.toUpperCase().padEnd(10)} ${finding.says}`);
    console.log(`     ${finding.because}`);
  }
  console.log(`\n${verdict.red ? 'RED' : 'GREEN'} -- the recording is at ${RECORDING}`);
  writeFileSync(VERDICT, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
  console.log(`the verdict, for a machine, is at ${VERDICT}`);
  console.log(`this run started ${String(powershellRuns())} powershell.exe`);
  process.exitCode = verdict.red ? 1 : 0;
  keep(verdict.red ? 'red' : 'green');
}

/*
 * The keeping wraps the whole run and not just the verdict, because a run that
 * DIED is the one a person most wants to read and the one that leaves no verdict
 * to say so. The failure is re-thrown untouched: this catch exists to copy, not
 * to decide, and a stand that swallowed its own death would report green.
 */
try {
  await main();
} catch (died) {
  // Before anything else, because it is the number a death from
  // `0xC0000142` is read against: how many processes this run had asked the
  // machine for by the time it was refused one.
  console.log(`\nthis run started ${String(powershellRuns())} powershell.exe before it died`);
  if (ownDirectoriesMade) {
    keep('died');
  } else {
    console.log('\nnothing of this run to keep: it stopped before it had directories of its own');
  }
  throw died;
}
