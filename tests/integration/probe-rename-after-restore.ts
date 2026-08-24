import * as os from 'node:os';
import * as vscode from 'vscode';

/**
 * Why a rename stopped landing once activation really restored a record.
 *
 * Not a test and not part of any gate -- deliberately not named `*.test.ts`.
 *
 * **The measurement, 2026-08-24 (Ш2).** Removing the test-host refusal in
 * `surveyTheMachine` made every run restore a seeded record, and
 * `terminal-rename.test.ts` went red with it: "gave up waiting for the tab to
 * take the new name". Three runs said the cause was not the code change --
 * with the same build and no record to restore, the suite passed -- and this
 * file says what the record's restore does that matters.
 *
 * It is not the restore. It is a terminal EDITOR that is created, NEVER
 * REVEALED, and then destroyed, which is what a restore looks like when the
 * conversation it starts ends at once. Run this file before
 * `terminal-rename.test.js` and the rename fails; replace the terminal below
 * with one that is shown before it is destroyed and the rename passes.
 *
 *     npx vscode-test --label integration \
 *       --run out/tests/integration/probe-rename-after-restore.js \
 *       --run out/tests/integration/terminal-rename.test.js
 *
 * **What it costs the product, and it is not nothing.** The rename is
 * `workbench.action.terminal.renameWithArg`, which renames whatever the
 * WORKBENCH calls the active terminal, while the extension asks
 * `window.activeTerminal` -- a mirror that arrives first. Between the two there
 * is a window in which a rename is dropped silently. The suite closes its own
 * exposure by awaiting `processId`; nothing in the build issues a rename inside
 * that window today, and that is an observation about the callers rather than a
 * property anything enforces.
 */
suite('a terminal editor nobody ever looked at', () => {
  test('is made and destroyed, so that the next rename can be watched', async () => {
    const terminal = vscode.window.createTerminal({
      name: 'gripterm-probe-unrevealed-before-rename',
      cwd: os.tmpdir(),
      location: { viewColumn: vscode.ViewColumn.Active },
      isTransient: true,
      shellPath: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    terminal.dispose();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    console.log(`the editor is left holding ${String(vscode.window.terminals.length)} terminals`);
  });
});
