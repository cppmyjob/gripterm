import * as os from 'node:os';
import * as vscode from 'vscode';

/**
 * Does a terminal EDITOR that is never revealed start its process?
 *
 * Not a test and not part of any gate -- deliberately not named `*.test.ts`.
 *
 * **The owner's store, 2026-08-23, after they closed Cursor and opened it
 * again.** Three records were restored. One of them -- the one whose tab was in
 * front -- has a pid and sent `ConversationStarted`. The other two have `pid: null`,
 * no events at all, and their conversations' transcripts were never touched.
 * On screen they were empty terminals, and twenty seconds later the list said
 * "state unknown" about them.
 *
 * `RestoreOrchestrator` creates a restored terminal WITHOUT revealing it, on
 * purpose: five terminals coming back must not fight over the cursor. The
 * question this asks is what that costs with the editor engine -- whether the
 * editor starts the process of a terminal whose tab nobody has looked at.
 */

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function watch(label: string, terminal: vscode.Terminal, seconds: number): Promise<number | undefined> {
  let pid: number | undefined;
  for (let tick = 1; tick <= seconds; tick += 1) {
    pid = await terminal.processId;
    if (pid !== undefined) {
      console.log(`  ${label}: the editor started its process after ~${String(tick)} s, pid ${String(pid)}`);
      return pid;
    }
    await pause(1000);
  }
  console.log(`  ${label}: NO PROCESS after ${String(seconds)} s`);
  return undefined;
}

suite('a terminal nobody revealed', () => {
  test('does the editor start it', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await pause(600);
    const file = await vscode.workspace.openTextDocument({
      content: 'a file of the person, in front of everything',
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.One });
    await vscode.commands.executeCommand('workbench.action.newGroupBelow');
    await pause(500);
    const strip = vscode.window.tabGroups.activeTabGroup.viewColumn;
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    await pause(400);

    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    // Three, the way a restore brings three back: made into the strip, none of
    // them shown, the person left where they were.
    const made = [1, 2, 3].map((n) =>
      vscode.window.createTerminal({
        name: `gripterm-probe-unrevealed-${String(n)}`,
        cwd: os.tmpdir(),
        shellPath: shell,
        isTransient: true,
        location: { viewColumn: strip, preserveFocus: true },
      })
    );
    try {
      await pause(1000);
      console.log(`  tabs now: ${vscode.window.tabGroups.all
        .map((group) => `[${String(group.viewColumn)}] ${group.tabs.map((tab) => tab.label).join(', ')}`)
        .join(' | ')}`);
      const before = await Promise.all(made.map(async (one, i) => await watch(`unrevealed ${String(i + 1)}`, one, 10)));
      console.log(`  unrevealed with a process: ${String(before.filter((pid) => pid !== undefined).length)} of 3`);

      // And now the thing the restore does when its wait expires.
      for (const one of made) {
        one.show(true);
        await pause(300);
      }
      await pause(1500);
      const after = await Promise.all(made.map(async (one, i) => await watch(`revealed ${String(i + 1)}`, one, 10)));
      console.log(`  after being shown, with a process: ${String(after.filter((pid) => pid !== undefined).length)} of 3`);
    } finally {
      for (const one of made) {
        one.dispose();
      }
      await pause(600);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
