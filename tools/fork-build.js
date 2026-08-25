'use strict';

const { existsSync, readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

/**
 * Which BUILD of which editor a measurement was taken in.
 *
 * **Why a whole file for five fields.** Every layout measurement this repository
 * holds is about a WORKBENCH, and the workbench of a fork ships every few days.
 * The records say which editor answered -- `editor: "Cursor.exe"` in the stand's
 * recordings -- and stop there, so two runs that disagree cannot be told from
 * one run whose editor moved under it. It is not hypothetical:
 * `gate/allowed-red.json` explains a point with a sentence read out of the
 * "Cursor 3.17.8 bundle" and the Cursor on this machine is 3.17.19, published
 * after that sentence was written. Ш9 asks for the fork's build number for
 * exactly this reason.
 *
 * **CommonJS, and on purpose.** Three readers need it and they are three module
 * systems: `.vscode-test.mjs` and `tests/stand/run.mjs` are ESM and reach it
 * through `createRequire`, and `tests/cursor/fork-build.test.ts` is a Jest
 * suite. A `.mjs` would be unreachable from the third without a build step, and
 * a compiled TypeScript module would put the recording of a build behind
 * `pnpm run build`, which is the one thing a record of what ran must not depend
 * on.
 *
 * Run by hand, it prints the record for an editor: `node tools/fork-build.js <exe>`.
 */

/**
 * Where an editor keeps `product.json`, relative to its executable.
 *
 * Two shapes, both measured on this machine on 2026-08-25. An INSTALLED editor
 * keeps it beside the executable -- Cursor does. A DOWNLOADED VS Code
 * (`.vscode-test/vscode-win32-x64-archive-1.134.0`) keeps `Code.exe` at the top
 * and the application under a directory named after the commit. Reading only
 * the first shape would leave the downloaded editor's build unrecorded, which is
 * half the runs.
 *
 * @param {string} executable the path to the editor's .exe
 * @returns {readonly string[]} the candidate product files, in the order tried
 */
function productFiles(executable) {
  const home = dirname(executable);
  const beside = join(home, 'resources', 'app', 'product.json');
  const { readdirSync } = require('node:fs');
  let below = [];
  try {
    below = readdirSync(home, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(home, entry.name, 'resources', 'app', 'product.json'));
  } catch {
    // No directory to look in is the same answer as nothing in it: the throw
    // below names both places, which is what a person needs either way.
    below = [];
  }
  return [beside, ...below];
}

/**
 * The build of the editor at `executable`, as five fields out of its own
 * `product.json` and nothing else.
 *
 * NOTHING here comes from the path. A record is a file that gets committed,
 * pasted into a report and sent to somebody, and the path to an editor names
 * whoever owns the machine.
 *
 * @param {string} executable the path to the editor's .exe
 * @returns {{editor: string, version: string, vscodeVersion: string | null, commit: string | null, built: string | null}}
 */
function forkBuild(executable) {
  const tried = productFiles(executable);
  const found = tried.find((file) => existsSync(file));
  if (found === undefined) {
    throw new Error(
      `no product.json for the editor at ${executable}: looked at ${tried.join(', ')}. ` +
      'Without it the build that answered goes unrecorded, and a measurement nobody can attribute ' +
      'to a build is not a measurement of a workbench.'
    );
  }
  const product = JSON.parse(readFileSync(found, 'utf8'));
  const version = product.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(
      `${found} has no \`version\`, so there is no build number to write down. Recording \`undefined\` ` +
      'as the build would be worse than recording nothing: it reads as an answer.'
    );
  }
  return {
    // `nameLong` and not the file name: `Cursor.exe` is a path, and the editor's
    // own name for itself is what its API answers as `vscode.env.appName`.
    editor: typeof product.nameLong === 'string' ? product.nameLong : 'an editor that does not name itself',
    version,
    // Absent in VS Code's own product.json and present in a fork's, measured
    // 2026-08-25. The absence IS the fact: filling it in with `version` would
    // make a fork and its upstream indistinguishable in the record that exists
    // to tell them apart.
    vscodeVersion: typeof product.vscodeVersion === 'string' ? product.vscodeVersion : null,
    commit: typeof product.commit === 'string' ? product.commit : null,
    built: typeof product.date === 'string' ? product.date : null,
  };
}

module.exports = { forkBuild };

if (require.main === module) {
  const executable = process.argv[2];
  if (executable === undefined) {
    process.stderr.write('usage: node tools/fork-build.js <path to the editor .exe>\n');
    process.exitCode = 2;
  } else {
    process.stdout.write(`${JSON.stringify(forkBuild(executable), null, 2)}\n`);
  }
}
