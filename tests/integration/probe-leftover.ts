import * as vscode from 'vscode';
import type { EditorLayout } from '@gripterm/core';

/**
 * What the editor brings back after a restart, when the strip was standing.
 *
 * Not a test and not part of any gate -- deliberately not named `*.test.ts`.
 *
 * The second half of `probe-empty-strip.ts`: run that one first, then this one
 * against the SAME `--user-data-dir` and the same folder. Whatever is on the
 * screen at the first line of this transcript is what the customer opens their
 * editor to.
 */

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

suite('what a restart brings back', () => {
  test('the editor area, before anything is asked of it', async () => {
    for (let look = 0; look <= 6; look += 1) {
      const layout = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
      console.log(`  +${String(look)} s  ${groups()}`);
      console.log(`         layout ${JSON.stringify(layout)}`);
      console.log(`         terminals the window lists: ${String(vscode.window.terminals.length)}`);
      await pause(1000);
    }
  });
});
