import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * Does the editor lock a group of its own accord when a terminal opens in it?
 *
 * Not a test and not part of any gate -- deliberately not named `*.test.ts`.
 *
 * This is the fact the fallback branch of `VsCodeEditorStrip.column` stands on.
 * That branch is reached when the editor refuses three times to split off a
 * group, and it puts the terminals into the one group there is while saying, in
 * a comment, that "NOTHING IS LOCKED and nothing is resized ... an unlocked
 * group takes the person's next file beside the terminals inside one group,
 * which is untidy and is not a trap".
 *
 * `workbench.editor.autoLockGroups` holds `terminalEditor: true` in its default.
 * If that default is in this editor, the sentence above is wrong: the editor
 * locks the group when our terminal opens in it, the person's next file has
 * nowhere to go but BESIDE, and the fallback is the trap reached by a second
 * road -- which is exactly what the owner reported on a build that has the fix.
 *
 * It must run in a window where NO Gripterm terminal has been made yet: the
 * strip watches the tab groups and repairs a strip that is alone in the editor
 * area, so a probe that runs after one of ours would measure our own repair.
 */

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

suite('the lock the editor puts on by itself', () => {
  test('what autoLockGroups says in this editor', async () => {
    const editor = vscode.workspace.getConfiguration('workbench.editor');
    const auto = editor.inspect<Record<string, boolean>>('autoLockGroups');
    console.log(`  default:  ${JSON.stringify(auto?.defaultValue)}`);
    console.log(`  in force: ${JSON.stringify(editor.get('autoLockGroups'))}`);
    console.log(`  closeEmptyGroups default: ${JSON.stringify(editor.inspect('closeEmptyGroups')?.defaultValue)}`);
    console.log(`  closeEmptyGroups in force: ${JSON.stringify(editor.get('closeEmptyGroups'))}`);
  });

  test('a terminal in the only group, and a file after it', async () => {
    const gripterm = await api();
    assert.equal(gripterm.registry.list().length, 0, 'this probe must run before any terminal of ours exists');

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await pause(800);
    console.log(`  before: ${groups()}`);
    assert.equal(vscode.window.tabGroups.all.length, 1, 'the editor area was not a single group');

    const terminal = vscode.window.createTerminal({
      name: 'a terminal in the only group there is',
      location: { viewColumn: vscode.ViewColumn.Active },
      isTransient: true,
    });
    terminal.show(false);
    await pause(2000);
    console.log(`  with a terminal in it: ${groups()}`);
    const before: number = vscode.window.tabGroups.all.length;

    const file = vscode.Uri.file(join(gripterm.readiness.storageDir, 'a-file-beside-a-lock.txt'));
    await writeFile(file.fsPath, 'a file opened while a terminal holds the only group\n', 'utf8');
    try {
      await vscode.commands.executeCommand('vscode.open', file);
      await pause(1500);
      const after: number = vscode.window.tabGroups.all.length;
      console.log(`  after a file was opened: ${groups()}`);
      console.log(`  groups went ${String(before)} -> ${String(after)}`);
      console.log(
        after > before
          ? '  THE EDITOR MADE A GROUP FOR THE FILE: the group was locked without us asking, so the fallback IS the trap'
          : '  the file joined the terminal as a tab: nothing locked the group'
      );
    } finally {
      terminal.dispose();
      await rm(file.fsPath, { force: true });
      await pause(600);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
