import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * The group the strip ADOPTS, and whether it is ours or everybody's.
 *
 * Not a test and not part of any gate -- deliberately not named `*.test.ts`.
 *
 * **The customer's log, 2026-08-22, four windows over five hours:**
 *
 *   the terminals went into the empty group at the end of the editor area
 *   {"column":2,"locked":false}
 *
 * `locked: false` every time. An unlocked strip takes the person's next file:
 * they open a terminal, the strip becomes the active group, they click a file
 * in the explorer, and it lands beside the terminal as a TAB -- which is what
 * "он делит область с файлами... справа от терминала появляется файл" says,
 * read as tabs rather than as panes.
 *
 * The live suite cannot show this red. Under VS Code the platform's own
 * `autoLockGroups.terminalEditor` locks the adopted group and covers for us;
 * measured in Cursor on the same day, it does NOT -- the editor's lock is for a
 * group MADE for an editor, not for one that was already there. So the red for
 * this rule lives here, in the editor the customer uses.
 */

type Spec = Parameters<GriptermApi['gateway']['create']>[0];

const TERMINAL_ID = { value: '4d4d4d4d-1b1b-4c4c-8d8d-2e2e2e2e2e2e' } as unknown as Spec['terminalId'];

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function groups(): string {
  return vscode.window.tabGroups.all
    .map((group) => {
      const held = group.tabs.map((tab) => tab.label).join(', ');
      return `[${String(group.viewColumn)}${group.isActive ? '*' : ' '}] ${held === '' ? '(empty)' : held}`;
    })
    .join('  |  ');
}

function columnOf(label: string): vscode.ViewColumn | undefined {
  return vscode.window.tabGroups.all.find((group) =>
    group.tabs.some((tab) => tab.label.includes(label))
  )?.viewColumn;
}

suite('the empty group the strip adopts', () => {
  test('a file opened while the strip is in front', async () => {
    const gripterm = await api();
    const auto = vscode.workspace.getConfiguration('workbench.editor').get<Record<string, boolean>>('autoLockGroups');
    console.log(`  autoLockGroups.terminalEditor in force: ${String(auto?.terminalEditor)}`);

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await pause(600);
    const file = await vscode.workspace.openTextDocument({
      content: 'a file of the person, in the group they work in',
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.One });
    // The shape a restart leaves: a group at the end with nothing in it.
    await vscode.commands.executeCommand('workbench.action.newGroupBelow');
    await pause(500);
    const strip = vscode.window.tabGroups.activeTabGroup.viewColumn;
    // And the person is NOT in it, which is the customer's window.
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    await pause(400);
    console.log(`  before the terminal: ${groups()}`);

    const handle = await gripterm.gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-probe-adopted',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });
    try {
      const until = Date.now() + 8000;
      while (columnOf('gripterm-probe-adopted') === undefined && Date.now() < until) {
        await pause(100);
      }
      console.log(`  with the terminal: ${groups()}`);
      const where = columnOf('gripterm-probe-adopted');
      console.log(`  the strip was column ${String(strip)}, the terminal is in ${String(where)}`);

      // The person turns to the terminal, then clicks a file in the explorer.
      handle.show(false);
      await pause(800);
      const wanderer = await vscode.workspace.openTextDocument({
        content: 'a file opened with no target while the strip is in front',
        language: 'plaintext',
      });
      const landed = (await vscode.window.showTextDocument(wanderer)).viewColumn;
      await pause(500);
      console.log(`  the file landed in column ${String(landed)}`);
      console.log(`  after: ${groups()}`);
      console.log(
        landed === where
          ? '  THE FILE WENT INTO THE STRIP: the adopted group is not ours, which is the complaint'
          : '  the file went elsewhere: the adopted group is locked'
      );
      assert.notEqual(landed, where, 'a file landed in the strip');
    } finally {
      handle.dispose();
      await pause(500);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
