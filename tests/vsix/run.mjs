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
 *   3. its own store and its own project folder, both temporary, so nothing this
 *      run makes lands near the person's own records.
 *
 * WHO ANSWERS AS `claude`, and what it costs. By default nobody real:
 * `GRIPTERM_VSIX_AGENT` is `fake` and the agent is the double of
 * `tests/acceptance/fake-claude/`, built by the same `build.mjs` the acceptance
 * builds it with. It spends nothing, needs no account, and keeps its session
 * files and transcripts in a `CLAUDE_CONFIG_DIR` inside this run's own
 * directory. It needs the C# compiler of the .NET Framework, which is what
 * `build.mjs` refuses without.
 *
 * WHAT THAT CORRECTED, 2026-08-31. Until that day this run had no choice in it
 * and always started a REAL `claude`, with no `CLAUDE_CONFIG_DIR` of its own --
 * so every packaging run laid a conversation in the profile of whoever ran it,
 * which is a person's own store and not a temporary one. The head of this file
 * said as much ("it costs a conversation in the CLI's own store") and nothing
 * was done about it: Ш32 had taken the real CLI off the acceptance's default
 * path and off nothing else.
 *
 * `GRIPTERM_VSIX_AGENT=real` is the run this used to be, kept reachable by name
 * rather than deleted. `CLAUDE_CONFIG_DIR` is deliberately NOT set in that mode,
 * because a real CLI has to run in the profile its person is logged into -- so
 * that mode still costs one conversation in that person's own store, and it is
 * asked for by name. Nothing is typed at the agent either way, so neither mode
 * costs tokens.
 *
 * WHAT THE DOUBLE COSTS IN EVIDENCE is not written here but at the check that
 * pays for it: `tests/vsix/index.ts`, `the button a person presses brings a
 * terminal up`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { downloadAndUnzipVSCode, runTests, runVSCodeCommand } from '@vscode/test-electron';
import { buildFakeClaude } from '../acceptance/fake-claude/build.mjs';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const EXTENSION = join(REPO, 'packages', 'extension');
const BASE = join(tmpdir(), 'gripterm-vsix');
const EXTENSIONS = join(BASE, 'extensions');
const USER_DATA = join(BASE, 'user-data');
const STORE = join(BASE, 'store');
const PROJECT = join(BASE, 'project');

/**
 * Where the agent keeps what it keeps: session files and transcripts.
 *
 * Only used in the `fake` mode, and for the reason `tests/acceptance/run.mjs`
 * states beside its own copy of this line: `CLAUDE_CONFIG_DIR` MOVES the CLI's
 * whole user level rather than adding to it [binary 2.1.228, quoted in
 * `settings-locations.ts`]. Pointing it here is what keeps a run of the double
 * out of a person's own profile. In the `real` mode it is left alone.
 */
const CLAUDE_CONFIG = join(BASE, 'claude-config');

/**
 * Who answers as `claude`.
 *
 * `fake` is the default because it is the one that costs nothing and touches
 * nobody's profile; `real` is the run that establishes what the double cannot
 * (see the head of this file, and the check in `index.ts` that names the
 * difference). The name and the two values are the acceptance's,
 * `GRIPTERM_ACCEPTANCE_AGENT`, deliberately: one idea should not have two
 * spellings across two runs a person reads on the same afternoon.
 */
const AGENT = process.env.GRIPTERM_VSIX_AGENT ?? 'fake';

if (AGENT !== 'fake' && AGENT !== 'real') {
  throw new Error(`GRIPTERM_VSIX_AGENT is '${AGENT}', and there are two: fake, real`);
}

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

/**
 * Puts the double where `claude` would be, and says so.
 *
 * The whole substitution is one directory in front of PATH, and it is the
 * acceptance's, line for line: `findExecutable` is what this build uses to find
 * `claude`, it walks PATH in order, and the editor this run launches inherits
 * this process's environment -- `@vscode/test-electron` spawns it with
 * `Object.assign({}, process.env, extensionTestsEnv)`.
 *
 * `CLAUDE_CONFIG_DIR` goes with it and does two jobs, again as it does there: it
 * tells the double where to keep its session files, and it keeps a run of it out
 * of the profile of whoever is logged in.
 *
 * @returns {string|null} where the double was put, or null when the agent is real
 */
function putTheDoubleOnThePath() {
  if (AGENT === 'real') {
    return null;
  }
  const where = buildFakeClaude();
  process.env.PATH = `${where};${process.env.PATH ?? ''}`;
  process.env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG;
  // The interpreter by absolute path: the launcher starts `node` on the double,
  // and a bare `node` on the PATH a terminal inherits is not guaranteed (C5-2).
  process.env.GRIPTERM_FAKE_CLAUDE_NODE = process.execPath;
  return where;
}

async function main() {
  step('a clean temporary profile, store and project');
  rmSync(BASE, { recursive: true, force: true });
  for (const directory of [EXTENSIONS, USER_DATA, STORE, PROJECT]) {
    mkdirSync(directory, { recursive: true });
  }
  if (AGENT === 'fake') {
    // Only where it is used: in the `real` mode the agent's profile is the
    // person's own, and an empty directory of ours beside it would read as one.
    mkdirSync(CLAUDE_CONFIG, { recursive: true });
  }
  // `gripterm.newTerminal` refuses without a folder open, and rightly: a Claude
  // Code session runs IN a project.
  writeFileSync(join(PROJECT, 'README.md'), 'A folder for the packaged extension to open a terminal in.\n', 'utf8');
  profile();

  step(`who answers as \`claude\`: ${AGENT}`);
  const double = putTheDoubleOnThePath();
  console.log(
    double === null
      ? 'a real `claude`, in the profile of whoever is logged in -- this run costs one conversation there'
      : `the double from ${double}, keeping its records in ${CLAUDE_CONFIG}`
  );

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
    extensionTestsEnv: {
      GRIPTERM_VSIX_EXTENSIONS: EXTENSIONS,
      // Which agent was chosen and where it was put, so the suite can REFUSE a
      // run whose substitution did not take effect. Without these two the double
      // failing to reach PATH would look exactly like the double working, and
      // the run would go on measuring a real CLI in a person's own profile --
      // silently, which is the whole defect this switch exists for.
      GRIPTERM_VSIX_AGENT: AGENT,
      GRIPTERM_VSIX_DOUBLE: double ?? '',
    },
  });
}

main()
  .then(() => {
    // Removed only when the run succeeded: a failure leaves the profile, the
    // store and the log where they can be read.
    rmSync(BASE, { recursive: true, force: true });
    // The agent is named in the last line as well as the first, because this is
    // the line a person reads as the answer: "a terminal came up" means one
    // thing with a real CLI behind it and a weaker thing with the double, and a
    // green that does not say which invites the stronger reading.
    console.log(
      `\nthe installed archive brought a terminal up, with the ${AGENT} agent behind it;` +
        ' the temporary profile has been removed'
    );
  })
  .catch((error) => {
    console.error(error);
    console.error(`\nthe temporary profile is left at ${BASE} for reading`);
    process.exit(1);
  });
