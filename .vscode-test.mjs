import { defineConfig } from '@vscode/test-cli';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostUserData, runStore } from './tools/host-user-data.mjs';
import { refuseStaleBuilds } from './tools/refuse-stale-builds.mjs';
import {
  howManyToSeed,
  seedMoreRestorableRecords,
  seedRestorableRecord,
} from './tools/seed-restorable-record.mjs';

const require_ = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const COMPILED = join(here, 'out', 'tests', 'integration');

/**
 * The Cursor of this machine, or `null`.
 *
 * The path and not a flag, because what the runner needs is the executable and
 * what the RECORD needs is the build beside it. Neither is downloaded: the
 * fork the customer works in is the one on this machine, and there is nowhere
 * to fetch a named build of it from.
 */
const CURSOR = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'cursor', 'Cursor.exe');

/** Where the Cursor strip writes the numbers the gate does arithmetic on. */
const CURSOR_OUT = join(here, '.vscode-test', 'cursor-output', 'rate.json');

/** A folder for the Cursor strip to open, made once and never remade. */
const CURSOR_PROJECT = join(here, '.vscode-test', 'cursor-project');

/**
 * The labels that run in Cursor -- none, when there is no Cursor here.
 *
 * **What this label is and is not.** It is NOT the live suites in Cursor, and
 * until 2026-08-25 that was recorded here as "not a choice". It is a choice.
 * The three launches this comment used to cite measured Cursor's extension test
 * host registering no third-party extension at all; 33 launches the same day,
 * driving `Cursor.exe` directly, put that where it belongs: a GLASS window
 * refuses them (48 entries in `vscode.extensions.all`, ours absent, 5 launches
 * of 5), and the same host outside glass registers ours -- 113 entries, 12
 * launches of 12 under `--classic`, 6 of 6 with no flag but a folder to open, 3
 * of 3 under `--glass --classic`. In a glass window the rest still follows:
 * every suite under `tests/integration` opens by asserting the extension is
 * there, so every one of them fails in its first hook. What runs here instead is
 * the fork's WORKBENCH, which needs no extension of ours and is where all four
 * of the customer's defects live -- and what it costs to run the live suites
 * here as well, plus the question of which window this stage ought to open, is
 * in the `cursor-live` entry of `tools/gate.mjs`.
 *
 * **Its exit code is not read by anything.** Measured the same day: this host's
 * exit code FLICKERS -- 5 launches of 12 under `--classic` exited 1, 0 of 6
 * with no flag, and four identical consecutive launches gave 1, 0, 0, 1. That
 * is a stronger reason than the stable 0 recorded here before, not a weaker
 * one: a host that is always 0 can be worked around by a rule, and one that
 * answers differently to the same command cannot be caught at all. The stage's
 * answer is the file at `CURSOR_OUT`, judged by `tools/gate.mjs` against
 * `gate/allowed-red.json`, and a run that died before writing it is red for
 * that reason. The gate DELETES that file
 * before it runs the stage -- here would be the wrong place, since this module
 * is loaded by every label including the two that run in VS Code, and clearing
 * a Cursor verdict on the way into a VS Code run is how a verdict goes missing
 * between being written and being read.
 *
 * @returns {object[]} the Cursor labels, or an empty list
 */
function inCursor() {
  if (!existsSync(CURSOR)) {
    return [];
  }
  // A folder, and it is load-bearing TWICE -- once for the reason it was added
  // and once for a reason nobody wrote down until 2026-08-25.
  //
  // The reason it was added, measured that day on Cursor 3.17.19: in a window
  // with no folder open, `workbench.action.newGroupBelow` threw `Invalid editor
  // group provided!` on 10 attempts out of 10, and with a folder open it made a
  // group on 10 out of 10 -- same host, same build, same minute. A probe
  // without a folder would measure a shell no customer sits in.
  //
  // The condition that comment NAMED was wrong, and 33 launches the same day
  // say so: the variable is not the folder, it is GLASS. A glass window throws
  // 10 of 10 (5 launches of 5); a window that is not glass throws 0 of 10 --
  // including `--classic` with NO folder, measured twice. The folder switched
  // glass off as a side effect: a path to open on the command line makes the
  // fork's `hasExplicitFirstWindowIntent` true, no decision about the first
  // window is taken, and on a fresh profile that decision is the only thing
  // that turns glass on.
  //
  // So the layout of this window is decided today by an argument that is here
  // for something else, and that is FRAGILE: drop the folder, or let the fork
  // change how it reads the command line, and this stage measures a different
  // window. `--classic` would say the same thing on purpose -- it beats even an
  // explicit `--glass`, 3 launches of 3. It is deliberately NOT added here: what
  // the `cursor` stage should measure -- a glass window, a classic one, or both
  // -- decides what this gate covers, and that question is the owner's; the
  // owner settled the first half of it on 2026-08-25 (the ordinary window is the
  // one he works in) and the arguments are unchanged.
  //
  // What Ш19 changed is the last four words of the paragraph above: "without a
  // word". The stage now READS which workbench it got, out of the fork's own
  // logs, and writes both readings into `rate.json` beside the numbers; the gate
  // refuses to judge a rate from any other one. The fragility is still here --
  // it is an argument doing two jobs -- and it is no longer silent.
  if (!existsSync(CURSOR_PROJECT)) {
    mkdirSync(CURSOR_PROJECT, { recursive: true });
    writeFileSync(
      join(CURSOR_PROJECT, 'README.md'),
      '# the folder the Cursor strip opens\n\nA window with no folder is not a window anybody works in.\n',
      'utf8'
    );
  }

  const { forkBuild } = require_('./tools/fork-build.js');
  const userData = hostUserData('cursor');
  return [
    {
      label: 'cursor',
      files: 'tests/cursor/*.js',
      extensionDevelopmentPath: 'packages/extension',
      useInstallation: { fromPath: CURSOR },
      workspaceFolder: CURSOR_PROJECT,
      // `--glass` ON DEMAND, and never in the gate:
      //
      //     GRIPTERM_CURSOR_GLASS=1 npx vscode-test --label cursor
      //
      // That is the acceptance of Ш19 and nothing else. A glass window misses 10
      // of 10 at `newGroupBelow` (measured 2026-08-25, 5 launches of 5), so a
      // gate that opened one would be red for ever; what the run is FOR is to
      // see the stage answer "not judged, this is the other workbench" instead
      // of naming a defect of the product. It is an environment variable rather
      // than a second label because a label is a thing the gate can pick up by
      // accident, and this must be asked for by hand every time.
      launchArgs: [`--user-data-dir=${userData}`, ...(process.env.GRIPTERM_CURSOR_GLASS === '1' ? ['--glass'] : [])],
      env: {
        GRIPTERM_CURSOR_OUT: CURSOR_OUT,
        // Where the window's own logs land, handed in rather than worked out
        // inside. The extension host's `process.argv` is not this process's, and
        // `--user-data-dir` is a launch argument of the editor: a suite that
        // guessed the default profile directory would read another window's logs
        // and say which workbench THAT was.
        GRIPTERM_CURSOR_USER_DATA: userData,
        // Read out here, where the executable is known. `vscode.version` inside
        // the window answers `1.128.0` for Cursor 3.17.19 -- the VS Code it is a
        // fork OF -- and a workbench measurement filed under that number is
        // filed under a build that never had this workbench in it.
        GRIPTERM_CURSOR_BUILD: JSON.stringify(forkBuild(CURSOR)),
      },
      mocha: { timeout: TIMEOUT_MS },
    },
  ];
}

// Two minutes because one test waits out a real restore: the twenty-second
// wait of `RestoreOrchestrator` is the thing under test there, and a real
// `claude` has to be started before it even begins.
const TIMEOUT_MS = 120000;

/**
 * The suites that do NOT run under our own engine, by name and with the reason.
 *
 * The criterion is the one M3.10 was given and no wider: a suite is out when its
 * SUBJECT is the shell or the terminal's place among the editors. Everything
 * else runs under both engines, because a suite that passes under one engine and
 * was never run under the other is a promise about half the product.
 *
 * A name here that matches no suite throws below, so a rename cannot quietly
 * turn an exclusion into an exclusion of nothing.
 */
const NOT_UNDER_OWN = new Map([
  ['quiet-shell.test.js', 'its subject is `gripterm.launch.mode: shell`, which our own engine refuses outright (M2.25, `chooseEngine`)'],
  ['editor-strip.test.js', 'its subject is the terminal`s place in the editor area -- it reads `window.tabGroups`'],
  ['terminal-rename.test.js', 'its subject is the name on an editor terminal -- it reads `window.terminals`'],
  ['closing-a-terminal.test.js', 'its subject is what the EDITOR does to a record when its tab or its group is closed'],
  ['tab-decoration.test.js', 'its subject is what is drawn on an EDITOR tab, and a terminal of our own has none'],
  ['terminal-gateway.test.js', 'its subject is the editor`s gateway itself; the half that is common to both engines is `terminal-gateway-contract.test.js`'],
]);

/** Every compiled suite except the named exclusions, as absolute paths. */
function suitesUnderOwn() {
  // Read from disk rather than globbed, because the exclusions below are applied
  // to what is really there. A missing directory is a build that has not been
  // run, and it is said in those words: the alternative is an ENOENT stack over
  // a path nobody recognises.
  let compiled;
  try {
    compiled = readdirSync(COMPILED);
  } catch {
    throw new Error(`no compiled suites in ${COMPILED} -- run \`pnpm run build:integration\` first`);
  }
  const present = new Set(compiled.filter((name) => name.endsWith('.test.js')));
  for (const [name, why] of NOT_UNDER_OWN) {
    if (!present.has(name)) {
      throw new Error(`the run under our own engine excludes '${name}' (${why}), and there is no such suite -- rename the exclusion or drop it`);
    }
  }
  return [...present].filter((name) => !NOT_UNDER_OWN.has(name)).map((name) => join(COMPILED, name));
}

/*
 * Both runs get a user data directory of their own, and with it a store of their
 * own. That is the whole of the isolation: `gripterm.storage.path` is read from
 * the window's settings, and until it was written there every suite ran against
 * `~/.gripterm` -- the store belonging to whoever owns this machine.
 *
 * Both runs also NAME THEIR ENGINE, and by setting rather than by hand:
 * `gripterm.terminal.engine` takes effect when the window starts, so an engine
 * cannot be switched inside a running suite, and a window that read the setting
 * is the only window that proves the setting works. `pty-engine.test.ts` asserts
 * from inside that the engine which answered is the one asked for.
 *
 * That sentence named `engine-in-effect.test.js` until 2026-08-30 and there has
 * never been a file of that name. The assertion it describes is real and is in
 * `pty-engine.test.ts`; only the address was invented. `named-tests-exist.test.ts`
 * did not catch it, and could not: it reads names ending `.test.ts` and
 * `.test.mjs`, and a suite named by its COMPILED `.js` name goes past it. The
 * name is written in its source form here so that this one, at least, is held.
 *
 * Until 2026-08-30 only the SECOND run named one. The first lived on whatever
 * the manifest defaulted to, which was `editor`, and that is a coincidence
 * rather than a choice: the day the owner moved the default to `own` this run
 * would have gone on being green while measuring the other engine, and every
 * suite here whose subject IS the editor's engine -- the strip among the
 * editors, the tabs drawn on it, the group that goes with its last terminal --
 * would have stopped measuring anything, with nothing red to say so.
 * `tests/every-run-names-its-engine.test.ts` now holds every run of ours to
 * saying which engine it is about.
 */

// Before anything is launched, and not as a courtesy: a host given a bundle
// older than its source measures code nobody wrote today, and says green about
// it. That cost a day on 2026-08-24 -- see tools/refuse-stale-builds.mjs.
refuseStaleBuilds();

/*
 * A record of a window that is gone, laid in each run's store before either host
 * exists.
 *
 * Here rather than in a suite because of WHEN it has to be there: the extension
 * activates on `onStartupFinished`, decides what to bring back, and is finished
 * with the question before mocha loads its first file. A record written by a
 * test would be a record the restore has already walked past, and the whole of
 * S01 -- "the terminals came back by themselves" -- would stay unmeasurable.
 * `activation-restore.test.js` reads what activation did with this.
 */
for (const label of ['integration', 'own']) {
  seedRestorableRecord(runStore(label));
  // One, unless somebody asked for more. `GRIPTERM_SEED_RECORDS` is how a person
  // measuring a restore of ten gets ten records to restore; unset -- which is
  // every gate -- it seeds nothing extra and this line does nothing at all.
  seedMoreRestorableRecords(runStore(label), howManyToSeed());
}

// Downloads a real VS Code and runs the integration suite inside it, so that
// "works in VS Code" is checked rather than assumed. The bundled extension is
// what gets loaded — `pnpm test:integration` builds it first.
export default defineConfig([
  {
    label: 'integration',
    files: 'out/tests/integration/**/*.test.js',
    extensionDevelopmentPath: 'packages/extension',
    version: 'stable',
    launchArgs: [
      // `editor`, and pinned rather than inherited: this is the run where the
      // editor's engine is the SUBJECT, and a default is not a subject.
      `--user-data-dir=${hostUserData('integration', { 'gripterm.terminal.engine': 'editor' })}`,
    ],
    mocha: { timeout: TIMEOUT_MS },
  },
  {
    label: 'own',
    files: suitesUnderOwn(),
    extensionDevelopmentPath: 'packages/extension',
    version: 'stable',
    launchArgs: [
      `--user-data-dir=${hostUserData('own', { 'gripterm.terminal.engine': 'own' })}`,
    ],
    mocha: { timeout: TIMEOUT_MS },
  },
  ...inCursor(),
]);
