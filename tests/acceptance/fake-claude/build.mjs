/*
 * Lays out the directory that goes on PATH in front of the real `claude`.
 *
 * Two files land in it: `claude.exe`, compiled from `claude-launcher.cs`, and a
 * copy of `fake-claude.mjs`, which the launcher looks for beside itself. It is
 * built into `.test-output/`, which is untracked and outside every packaging
 * glob -- the double must not be able to reach a person's machine.
 *
 * THE ROUND TRIP IS MEASURED HERE AND NOT ASSUMED. The launcher has to carry an
 * argument vector across a Windows command line, and the quoting for that is
 * written out by hand in C# because .NET Framework offers no `ArgumentList`. So
 * before anything is allowed to use this directory, a deliberately nasty vector
 * is put through the compiled executable and compared with what comes back. A
 * quoting defect would otherwise show up as an acceptance failure nobody could
 * read.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(dirname(dirname(HERE)));

/**
 * The C# compiler of the .NET Framework, which Windows ships.
 *
 * Named by absolute path rather than looked for on PATH: `csc` on a PATH may be
 * Roslyn out of a Visual Studio installation, a different compiler with
 * different defaults, and this file wants the one that is always there.
 */
const CSC = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'Microsoft.NET',
  'Framework64',
  'v4.0.30319',
  'csc.exe'
);

/** A vector chosen to break a naive quoter: spaces, quotes, backslashes, and the characters `cmd` eats. */
const NASTY = ['a b', 'c&d|e^f', 'back\\slash\\', 'quo"te', '--session-id', '3f1c2b8a-4d5e-4f60-9a71-b2c3d4e5f607'];

/**
 * Builds the directory and hands back where it is.
 *
 * @param {string} [into] where to build it; `.test-output/fake-claude` by default
 * @returns {string} the directory to put on PATH
 */
export function buildFakeClaude(into = join(REPO, '.test-output', 'fake-claude')) {
  if (!existsSync(CSC)) {
    throw new Error(
      `the acceptance double needs the C# compiler of the .NET Framework and there is none at ${CSC}. ` +
        'Without it there is no `claude.exe` to put on PATH, and the acceptance suites cannot run ' +
        'against anything but a real `claude`.'
    );
  }
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  copyFileSync(join(HERE, 'fake-claude.mjs'), join(into, 'fake-claude.mjs'));

  const exe = join(into, 'claude.exe');
  execFileSync(
    CSC,
    ['-nologo', '-optimize+', '-target:exe', `-out:${exe}`, join(HERE, 'claude-launcher.cs')],
    { stdio: 'pipe' }
  );

  proveTheVectorSurvives(exe);
  return into;
}

/** The launcher hands the double exactly what it was given, or nothing here may be used. */
function proveTheVectorSurvives(exe) {
  const printed = execFileSync(exe, ['--gripterm-echo-argv', ...NASTY], {
    encoding: 'utf8',
    env: { ...process.env, GRIPTERM_FAKE_CLAUDE_NODE: process.execPath, CLAUDE_CONFIG_DIR: dirname(exe) },
  });
  const came = JSON.parse(printed);
  const went = JSON.stringify(NASTY);
  if (JSON.stringify(came) !== went) {
    throw new Error(
      `the acceptance launcher mangles arguments: sent ${went}, got ${JSON.stringify(came)}`
    );
  }
}

// Runnable as a script as well as importable, because the two callers cannot
// share one shape: `tests/acceptance/run.mjs` imports it, and `tests/fake-claude.test.ts`
// is CommonJS under ts-jest and cannot import an ES module at all.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${buildFakeClaude(process.argv[2])}${'\n'}`);
}
