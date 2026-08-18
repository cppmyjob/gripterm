/*
 * The last acceptance line of M3.12, run rather than described: a VSIX built from
 * this tree, installed the way a person installs one, and asked to bring a
 * terminal up.
 *
 * Three things it deliberately does NOT share with `pnpm test:integration`:
 *
 *   1. the tree it runs. `test:integration` loads `packages/extension` -- sources
 *      beside the bundle, `node_modules` behind it, nothing filtered by
 *      `.vscodeignore`. This run loads the directory the editor produced by
 *      unpacking the .vsix, and the suite asserts where the answering code came
 *      from before it asserts anything else.
 *   2. its own `--extensions-dir`. Installing into the shared `.vscode-test`
 *      profile would leave an installed Gripterm sitting beside the development
 *      one in every ordinary integration run afterwards.
 *   3. its own store and its own project folder, both temporary, so a real
 *      `claude` started here writes nowhere near the person's own records.
 *
 * Nothing is typed at the agent: it costs a conversation in the CLI's own store
 * and no tokens.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { downloadAndUnzipVSCode, runTests, runVSCodeCommand } from '@vscode/test-electron';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const EXTENSION = join(REPO, 'packages', 'extension');
const BASE = join(tmpdir(), 'gripterm-vsix');
const EXTENSIONS = join(BASE, 'extensions');
const USER_DATA = join(BASE, 'user-data');
const STORE = join(BASE, 'store');
const PROJECT = join(BASE, 'project');

/*
 * `@vscode/test-electron` spawns the CLI through a shell on Windows (CVE-2024-27980)
 * and quotes only the executable, so an argument with a space in it arrives as two.
 * Every path this script passes is built from `os.tmpdir()` and the repository
 * root; if either has a space, this says so instead of failing later as an
 * unrecognised argument.
 */
for (const [what, path] of [['the temporary directory', BASE], ['the repository', REPO]]) {
  if (path.includes(' ')) {
    throw new Error(`${what} is at '${path}', which has a space in it -- the editor CLI is spawned through a shell here and would read that path as two arguments`);
  }
}

function step(what) {
  console.log(`\n=== ${what} ===`);
}

/** The archive this run installs. Deleted first, so a failed packaging cannot leave yesterday's file to be installed. */
function packaged() {
  const manifest = JSON.parse(readFileSync(join(EXTENSION, 'package.json'), 'utf8'));
  const vsix = join(EXTENSION, `${manifest.name}-${manifest.version}.vsix`);
  rmSync(vsix, { force: true });
  execFileSync('pnpm', ['run', 'package'], { cwd: REPO, stdio: 'inherit', shell: true });
  if (!existsSync(vsix)) {
    throw new Error(`\`pnpm run package\` reported success and there is no ${vsix}`);
  }
  return vsix;
}

/**
 * A profile with the engine and the store set in it.
 *
 * The setting is the honest way in: `gripterm.terminal.engine` is read when the
 * window starts, so the only window that proves it works is one that read it --
 * and the run is worth nothing under the editor's engine, since the whole subject
 * here is the addon that travelled in the archive. `index.ts` asserts from inside
 * which engine answered.
 */
function profile() {
  mkdirSync(join(USER_DATA, 'User'), { recursive: true });
  writeFileSync(
    join(USER_DATA, 'User', 'settings.json'),
    `${JSON.stringify({
      'gripterm.terminal.engine': 'own',
      'gripterm.storage.path': STORE,
      // A window that talks to nobody else's store still sweeps its own; thirty
      // seconds of it inside a run this short is noise in the log.
      'gripterm.reconcile.intervalSeconds': 3600,
      'gripterm.notify.toastStates': [],
    }, null, 2)}\n`,
    'utf8'
  );
}

/**
 * Where the editor put the archive when it unpacked it.
 *
 * Found rather than composed from the manifest: the directory name is the
 * editor's own convention, and a run that guessed it wrong would look exactly
 * like a run whose installation failed.
 */
function unpacked() {
  const directories = readdirSync(EXTENSIONS).filter((name) => statSync(join(EXTENSIONS, name)).isDirectory());
  if (directories.length !== 1) {
    throw new Error(`expected exactly one unpacked extension in ${EXTENSIONS}, found ${JSON.stringify(directories)}`);
  }
  return join(EXTENSIONS, directories[0]);
}

async function main() {
  step('a clean temporary profile, store and project');
  rmSync(BASE, { recursive: true, force: true });
  for (const directory of [EXTENSIONS, USER_DATA, STORE, PROJECT]) {
    mkdirSync(directory, { recursive: true });
  }
  // `gripterm.newTerminal` refuses without a folder open, and rightly: a Claude
  // Code session runs IN a project.
  writeFileSync(join(PROJECT, 'README.md'), 'A folder for the packaged extension to open a terminal in.\n', 'utf8');
  profile();

  step('building and packaging');
  const vsix = packaged();
  console.log(`packaged ${vsix}`);

  step('installing the archive into the temporary profile');
  const executable = await downloadAndUnzipVSCode('stable');
  const installed = await runVSCodeCommand([
    '--extensions-dir', EXTENSIONS,
    '--user-data-dir', USER_DATA,
    '--install-extension', vsix,
    '--force',
  ]);
  console.log(installed.stdout.trim());

  const archive = unpacked();
  console.log(`the editor unpacked it to ${archive}`);

  step('asking the installed extension to work');
  /*
   * `extensionDevelopmentPath` points AT THE UNPACKED ARCHIVE, and that is the
   * whole arrangement rather than a detail. Two facts had to be reconciled:
   *
   *   * `--extensionTestsPath` is only run by an editor in extension development
   *     mode. Measured 2026-08-18: with no development path at all the window
   *     came up, activated the installed extension out of `--extensions-dir` and
   *     then sat there -- ten minutes, no test output, nothing to say why.
   *   * a development path pointing at `packages/extension` would load the
   *     REPOSITORY: sources beside the bundle, `node_modules` behind it, nothing
   *     filtered by `.vscodeignore`. That is the tree every other suite already
   *     runs, and running it here would make this one prove nothing.
   *
   * So the development path is the directory the editor itself produced from the
   * .vsix. What runs is what a person installs, and `index.ts` asserts that the
   * code answering lives under this directory before it asserts anything else.
   */
  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: [archive],
    extensionTestsPath: join(REPO, 'out', 'tests', 'vsix', 'index.js'),
    launchArgs: [
      '--extensions-dir', EXTENSIONS,
      '--user-data-dir', USER_DATA,
      '--disable-workspace-trust',
      PROJECT,
    ],
    extensionTestsEnv: { GRIPTERM_VSIX_EXTENSIONS: EXTENSIONS },
  });
}

main()
  .then(() => {
    // Removed only when the run succeeded: a failure leaves the profile, the
    // store and the log where they can be read.
    rmSync(BASE, { recursive: true, force: true });
    console.log('\nthe installed archive brought a terminal up; the temporary profile has been removed');
  })
  .catch((error) => {
    console.error(error);
    console.error(`\nthe temporary profile is left at ${BASE} for reading`);
    process.exit(1);
  });
