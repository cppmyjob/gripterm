import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * The owner's first move, made the way the owner makes it.
 *
 * Not a test and not part of any gate -- deliberately not named `*.test.ts`,
 * which is what the two runs in `.vscode-test.mjs` glob for. Started by hand
 * through `spikes/cursor-probe`; what it produces is a transcript to read.
 *
 * **The owner, 2026-08-22, on a build that has every fix:** "область файлов
 * чистая, нет ни панелей, ничего. Кликаю + в Claude Code Terminals. Появляется
 * новый терминал на всю область файлов. Он делит область с файлами -- если
 * кликнуть на файл, то справа от терминала появляется файл."
 *
 * `probe-owner-moves.ts` did not reproduce that, and the difference between the
 * two is what this file is: it presses the button the owner presses, from the
 * place the owner presses it (the list has the focus, not the editor area), in a
 * window that has only just started.
 *
 * The second test is about the PLATFORM and not about us, and it is the one that
 * decides whether the fallback branch of `VsCodeEditorStrip.column` is honest.
 * That branch says "nothing is locked, so the person's next file lands in this
 * group beside the terminals" -- while `workbench.editor.autoLockGroups` holds
 * `terminalEditor: true` by default, and the editor locks the group ITSELF when
 * our terminal opens in it. If it does, the fallback is not a fallback: it is
 * the trap, reached by a different road.
 */

type Entry = Awaited<ReturnType<GriptermApi['lifecycle']['launch']>>;

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function kindOf(tab: vscode.Tab): string {
  if (tab.input instanceof vscode.TabInputTerminal) {
    return 'terminal';
  }
  if (tab.input instanceof vscode.TabInputText) {
    return 'file';
  }
  return 'other';
}

function groups(): string {
  return vscode.window.tabGroups.all
    .map((group) => {
      const held = group.tabs.map((tab) => `${kindOf(tab)}:${tab.label}`).join(', ');
      return `[${String(group.viewColumn)}${group.isActive ? '*' : ' '}] ${held === '' ? '(empty)' : held}`;
    })
    .join('  |  ');
}

async function snap(label: string): Promise<void> {
  const layout = await vscode.commands.executeCommand('vscode.getEditorLayout');
  console.log(`  ${label}\n      groups: ${groups()}\n      layout: ${JSON.stringify(layout)}`);
}

function stripColumn(): vscode.ViewColumn | null {
  const strip = vscode.window.tabGroups.all.find(
    (group) => group.tabs.length > 0 && group.tabs.every((tab) => tab.input instanceof vscode.TabInputTerminal)
  );
  return strip?.viewColumn ?? null;
}

/** Everything this window holds of ours, gone, so the next test starts clean. */
async function scrubAll(gripterm: GriptermApi): Promise<void> {
  const { registry, lifecycle, readiness } = gripterm;
  for (const entry of registry.list()) {
    if (registry.knows(entry.terminalId)) {
      lifecycle.close(entry.terminalId);
    }
  }
  await pause(1500);
  for (const entry of registry.list()) {
    if (registry.knows(entry.terminalId)) {
      lifecycle.discard(entry.terminalId);
    }
  }
  await pause(800);
  await rm(join(readiness.storageDir, 'terminals'), { recursive: true, force: true });
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await pause(500);
}

suite('the plus, pressed where the owner presses it', () => {
  test('C. the list has the focus and the window has only just started', async () => {
    const gripterm = await api();
    const { readiness } = gripterm;
    assert.notEqual(readiness.cliPath, null, 'claude was not found on PATH, and this probe starts a real one');

    await snap('what the window looks like when the probe gets its turn');
    // The list, focused, which is where a hand is when it reaches the plus.
    await vscode.commands.executeCommand('gripterm.terminals.focus');
    await pause(400);
    await snap('after the list took the focus');

    let entry: Entry | null = null;
    try {
      await vscode.commands.executeCommand('gripterm.newTerminal');
      for (let tick = 1; tick <= 8; tick += 1) {
        await pause(400);
        await snap(`+${String(tick * 400)} ms after the plus`);
      }
      entry = gripterm.registry.list()[0] ?? null;

      const before = vscode.window.tabGroups.all.length;
      const strip = stripColumn();
      console.log(`  the strip is column ${String(strip)}, and there are ${String(before)} groups`);

      const file = vscode.Uri.file(join(readiness.storageDir, 'a-file-the-owner-clicks.txt'));
      await writeFile(file.fsPath, 'the file a person clicks in the explorer\n', 'utf8');
      await vscode.commands.executeCommand('vscode.open', file);
      await pause(1500);
      await snap('after a file was opened, which is where the owner says it goes wrong');
      console.log(`  groups went ${String(before)} -> ${String(vscode.window.tabGroups.all.length)}`);
      await rm(file.fsPath, { force: true });
    } finally {
      await scrubAll(gripterm);
    }
    assert.ok(entry, 'the plus started nothing at all');
  });

  test('D. what the editor does with a terminal in the only group there is', async () => {
    /*
     * No Gripterm in this one on purpose: a terminal made straight from the API,
     * into the active group, with no split of ours anywhere near it. What is
     * being asked is whether `autoLockGroups` locks that group -- which the API
     * does not say, so it is asked the way a person meets it: open a file
     * afterwards and see whether the editor had to MAKE a group for it.
     */
    const gripterm = await api();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await pause(600);
    await snap('an editor area with one empty group');

    const terminal = vscode.window.createTerminal({
      name: 'a terminal in the only group there is',
      location: { viewColumn: vscode.ViewColumn.Active },
      isTransient: true,
    });
    terminal.show(false);
    await pause(1500);
    await snap('after a terminal opened in it');
    const before = vscode.window.tabGroups.all.length;

    const file = vscode.Uri.file(join(gripterm.readiness.storageDir, 'a-file-beside-a-lock.txt'));
    await writeFile(file.fsPath, 'a file opened while a terminal holds the only group\n', 'utf8');
    try {
      await vscode.commands.executeCommand('vscode.open', file);
      await pause(1500);
      await snap('after a file was opened into it');
      const after = vscode.window.tabGroups.all.length;
      console.log(`  groups went ${String(before)} -> ${String(after)}`);
      console.log(
        after > before
          ? '  THE EDITOR MADE A GROUP: the single group was locked, so a fallback that puts terminals there is the trap'
          : '  the file joined the terminal in one group: nothing locked it'
      );
    } finally {
      terminal.dispose();
      await rm(file.fsPath, { force: true });
      await pause(500);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
