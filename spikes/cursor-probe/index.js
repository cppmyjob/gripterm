'use strict';

const path = require('node:path');

// By absolute path, because pnpm does not hoist mocha to a place the extension
// host's loader would find from this directory.
const Mocha = require(
  path.resolve(__dirname, '..', '..', 'node_modules', '.pnpm', 'mocha@10.8.2', 'node_modules', 'mocha')
);

/**
 * The integration probe, run inside CURSOR rather than inside VS Code.
 *
 * Why this exists at all: the customer's editor is Cursor, and every layout
 * measurement this repository holds was taken in VS Code stable. Cursor is a
 * fork -- its workbench decides where a file lands when the active group is
 * locked, whether an empty group survives, and whether a context key reaches an
 * extension's menu -- so a rule verified in one is a rule ASSUMED in the other.
 *
 * Not part of any gate. It is started by hand, against the Cursor on this
 * machine, and what it produces is a transcript to read:
 *
 *   Cursor.exe --extensionDevelopmentPath=<repo>/packages/extension \
 *              --extensionTestsPath=<repo>/spikes/cursor-probe \
 *              --user-data-dir=<scratch> --disable-extensions
 *
 * `GRIPTERM_PROBE` names the compiled suite to run; it defaults to the probe
 * the layout work is about.
 */
function run() {
  const mocha = new Mocha({ ui: 'tdd', color: false, timeout: 120000 });
  const suite = process.env.GRIPTERM_PROBE ?? 'probe-customer.test.js';
  mocha.addFile(path.resolve(__dirname, '..', '..', 'out', 'tests', 'integration', suite));

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} probe assertions failed`));
          return;
        }
        resolve();
      });
    } catch (cause) {
      reject(cause);
    }
  });
}

module.exports = { run };
