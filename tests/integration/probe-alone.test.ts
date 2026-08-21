import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { GriptermApi } from '../../packages/extension/src/extension';

/** TEMPORARY INSTRUMENT for the customer's complaint 6. Deleted when it has answered. */

type Spec = Parameters<GriptermApi['gateway']['create']>[0];

const PROBE_ID = '550e8400-e29b-41d4-a716-4466553102cc';

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

function groups(): string {
  return vscode.window.tabGroups.all
    .map(
      (group) =>
        `[${String(group.viewColumn)}${group.isActive ? '*' : ''}] ${
          group.tabs.length === 0 ? '(empty)' : group.tabs.map((tab) => tab.label).join(', ')
        }`
    )
    .join(' | ');
}

async function layout(): Promise<string> {
  return JSON.stringify(await vscode.commands.executeCommand('vscode.getEditorLayout'));
}

async function waitFor(what: string, ready: () => boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > until) {
      throw new Error(`gave up waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function columnOf(label: string): vscode.ViewColumn | undefined {
  return vscode.window.tabGroups.all.find((group) =>
    group.tabs.some((tab) => tab.label.includes(label))
  )?.viewColumn;
}

suite('PROBE: the strip left alone', () => {
  test('what a group made above it does', async () => {
    const { gateway } = await api();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await new Promise((resolve) => setTimeout(resolve, 500));

    const handle = await gateway.create({
      terminalId: PROBE_ID as unknown as Spec['terminalId'],
      name: 'gripterm-probe-lonely',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });
    try {
      await waitFor('the terminal to get a tab', () => columnOf('gripterm-probe-lonely') !== undefined);
      handle.show(false);
      await new Promise((resolve) => setTimeout(resolve, 300));
      console.log(`[probe] with a group above : ${groups()} :: ${await layout()}`);
      console.log(`[probe] active terminal    : ${String(vscode.window.activeTerminal?.name)}`);

      // The person closes their last file: the editor takes the empty group away.
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
      await vscode.commands.executeCommand('workbench.action.closeGroup');
      await new Promise((resolve) => setTimeout(resolve, 500));
      console.log(`[probe] alone              : ${groups()} :: ${await layout()}`);
      console.log(`[probe] active terminal    : ${String(vscode.window.activeTerminal?.name)}`);

      // The cure under test: a group above, so that a file has somewhere to land.
      await vscode.commands.executeCommand('workbench.action.newGroupAbove');
      await new Promise((resolve) => setTimeout(resolve, 300));
      console.log(`[probe] after newGroupAbove: ${groups()} :: ${await layout()}`);
      console.log(`[probe] terminal is now in : ${String(columnOf('gripterm-probe-lonely'))}`);
      console.log(`[probe] active terminal    : ${String(vscode.window.activeTerminal?.name)}`);

      const file = await vscode.workspace.openTextDocument({
        content: 'the file opened after the cure',
        language: 'plaintext',
      });
      const landed = (await vscode.window.showTextDocument(file)).viewColumn;
      console.log(`[probe] file landed in     : ${String(landed)}`);
      console.log(`[probe] end                : ${groups()} :: ${await layout()}`);
    } finally {
      handle.dispose();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
