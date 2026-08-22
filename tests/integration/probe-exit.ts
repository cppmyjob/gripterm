import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';

/**
 * What the editor says about a terminal whose process ended by itself.
 *
 * Not a test and not part of any gate -- deliberately not named `*.test.ts`.
 *
 * **The customer's log, 2026-08-22, five hours and seven terminals.** Not one
 * `a terminal closed` (the editor's own `onDidCloseTerminal`) and not one
 * `a terminal was closed by the person` (our command). Only
 * `a terminal was found without its process`, seven times -- the reconciler's
 * sweep, which runs every thirty seconds. And beside it, at the moment they
 * deleted the record, `a record being deleted still had a pane of its own`:
 * the TAB was still there.
 *
 * So the agent ends, the tab stays, and nothing tells us until the sweep. That
 * is "долго статус изменяется -- до минуты".
 *
 * Two things could carry the news sooner, and this asks which of them exists:
 *
 *   * `onDidCloseTerminal` -- does the editor close the terminal when its
 *     process ends, or keep the tab?
 *   * `Terminal.exitStatus` -- is it set while the tab is still open? That
 *     would be the editor's own answer, free to read, and no inference.
 */

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

suite('a terminal whose process ends by itself', () => {
  test('what the editor tells us, and when', async () => {
    const closed: { at: number | null } = { at: null };
    const heard = vscode.window.onDidCloseTerminal(() => {
      closed.at ??= Date.now();
    });
    // A shell that ends at once, which is what an agent quitting looks like to
    // the editor: the process behind the terminal is gone and nothing killed it.
    const terminal = vscode.window.createTerminal({
      name: 'gripterm-probe-exit',
      cwd: os.tmpdir(),
      shellPath: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      shellArgs: process.platform === 'win32' ? ['/c', 'exit 7'] : ['-c', 'exit 7'],
      location: vscode.TerminalLocation.Editor,
      isTransient: true,
    });
    const started = Date.now();
    try {
      let sawStatus: number | null = null;
      for (let tick = 1; tick <= 40; tick += 1) {
        await pause(250);
        if (sawStatus === null && terminal.exitStatus !== undefined) {
          sawStatus = Date.now();
        }
        if (sawStatus !== null && closed.at !== null) {
          break;
        }
      }
      const tabs = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((tab) => tab.label.includes('gripterm-probe-exit')).length;

      console.log(`  onDidCloseTerminal fired after ${closed.at === null ? 'NEVER (10 s)' : `${String(closed.at - started)} ms`}`);
      console.log(`  exitStatus appeared after ${sawStatus === null ? 'NEVER (10 s)' : `${String(sawStatus - started)} ms`}`);
      console.log(`  exitStatus now: ${JSON.stringify(terminal.exitStatus)}`);
      console.log(`  tabs still carrying the name: ${String(tabs)}`);
      console.log(`  terminals the window still lists: ${String(vscode.window.terminals.filter((one) => one.name.includes('gripterm-probe-exit')).length)}`);
    } finally {
      heard.dispose();
      terminal.dispose();
      await pause(400);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
    assert.ok(true);
  });
});
