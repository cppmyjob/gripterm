import { defineConfig } from '@vscode/test-cli';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const COMPILED = join(here, 'out', 'tests', 'integration');

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

/**
 * A user data directory of our own for the second run, with the engine set in it.
 *
 * The setting is the honest way in: `gripterm.terminal.engine` takes effect when
 * the window starts, so an engine cannot be switched inside a running suite, and
 * a window that read the setting is the only window that proves the setting
 * works. Seeded here rather than by hand so that the second run cannot be the
 * first run wearing a different label -- and `engine-in-effect.test.js` asserts
 * from inside that the engine which answered is the one asked for.
 */
function userDataWithOwnEngine() {
  const directory = join(here, '.vscode-test', 'user-data-own');
  mkdirSync(join(directory, 'User'), { recursive: true });
  writeFileSync(
    join(directory, 'User', 'settings.json'),
    `${JSON.stringify({ 'gripterm.terminal.engine': 'own' }, null, 2)}\n`,
    'utf8'
  );
  return directory;
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
    mocha: { timeout: TIMEOUT_MS },
  },
  {
    label: 'own',
    files: suitesUnderOwn(),
    extensionDevelopmentPath: 'packages/extension',
    version: 'stable',
    launchArgs: [`--user-data-dir=${userDataWithOwnEngine()}`],
    mocha: { timeout: TIMEOUT_MS },
  },
]);
