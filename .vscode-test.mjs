import { defineConfig } from '@vscode/test-cli';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostUserData, runStore } from './tools/host-user-data.mjs';
import { refuseStaleBuilds } from './tools/refuse-stale-builds.mjs';
import { seedRestorableRecord } from './tools/seed-restorable-record.mjs';

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
 * that is not a choice. Measured 2026-08-25 over three launches and two
 * launchers, polling for thirty seconds each: Cursor's extension test host --
 * any window carrying `--extensionTestsPath` -- registers no third-party
 * extension at all, developed or installed, while the same arguments against VS
 * Code 1.134.0 register ours at once. Every suite under `tests/integration`
 * opens by asserting the extension is there, so in Cursor every one of them
 * fails in its first hook. What runs here instead is the fork's WORKBENCH,
 * which needs no extension of ours and is where all four of the customer's
 * defects live.
 *
 * **Its exit code is not read by anything.** Measured the same day: this host
 * exits 0 on a failing run. The stage's answer is the file at `CURSOR_OUT`,
 * judged by `tools/gate.mjs` against `gate/allowed-red.json`, and a run that
 * died before writing it is red for that reason. The gate DELETES that file
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
  // A folder, and it is load-bearing. Measured 2026-08-25 on Cursor 3.17.19:
  // in a window with NO folder open, `workbench.action.newGroupBelow` threw
  // `Invalid editor group provided!` on 10 attempts out of 10, and with a
  // folder open it made a group on 10 out of 10 -- in the same host, the same
  // build, the same minute. A probe without a folder would measure a shell no
  // customer sits in and report a defect that is not there.
  if (!existsSync(CURSOR_PROJECT)) {
    mkdirSync(CURSOR_PROJECT, { recursive: true });
    writeFileSync(
      join(CURSOR_PROJECT, 'README.md'),
      '# the folder the Cursor strip opens\n\nA window with no folder is not a window anybody works in.\n',
      'utf8'
    );
  }

  const { forkBuild } = require_('./tools/fork-build.js');
  return [
    {
      label: 'cursor',
      files: 'tests/cursor/*.js',
      extensionDevelopmentPath: 'packages/extension',
      useInstallation: { fromPath: CURSOR },
      workspaceFolder: CURSOR_PROJECT,
      launchArgs: [`--user-data-dir=${hostUserData('cursor')}`],
      env: {
        GRIPTERM_CURSOR_OUT: CURSOR_OUT,
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
 * The second run also gets the engine, and by setting rather than by hand:
 * `gripterm.terminal.engine` takes effect when the window starts, so an engine
 * cannot be switched inside a running suite, and a window that read the setting
 * is the only window that proves the setting works. `engine-in-effect.test.js`
 * asserts from inside that the engine which answered is the one asked for.
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
    launchArgs: [`--user-data-dir=${hostUserData('integration')}`],
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
