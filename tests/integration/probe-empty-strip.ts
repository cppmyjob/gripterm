import * as os from 'node:os';
import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * What is left behind when the last terminal of the strip goes away, and what
 * comes back after a restart.
 *
 * Not a test and not part of any gate -- deliberately not named `*.test.ts`.
 *
 * **The customer, 2026-08-22, on the build that finally put the strip below the
 * editors:** "теперь открывается в панели как нужно НО при переоткрытии
 * остаётся пустая панель". An empty strip holding a third of the editor area
 * and nothing in it.
 *
 * Two ways that can happen, and this asks the editor which of them is real:
 *
 *   * the last terminal closes and the group stays -- `closeEmptyGroups` is on
 *     by default, but the strip is LOCKED since `545ec4d` and a locked group
 *     may well be exempt;
 *   * the grid comes back from a restart with the group in it while our
 *     terminals do not come back at all, because every terminal we make is
 *     `isTransient: true` (A3).
 *
 * The run leaves a strip standing on purpose: `probe-leftover.ts`, started
 * afterwards against the SAME `--user-data-dir` and the same folder, is the
 * second half of the second question.
 */

const TERMINAL_ID = { value: '5e5e5e5e-1b1b-4c4c-8d8d-2e2e2e2e2e2e' };

type Spec = Parameters<GriptermApi['gateway']['create']>[0];

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

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

/** A terminal made the way the product makes them: through the strip. */
async function terminalInTheStrip(gripterm: GriptermApi, name: string): Promise<{
  handle: Awaited<ReturnType<GriptermApi['gateway']['create']>>;
  column: vscode.ViewColumn | undefined;
}> {
  const file = await vscode.workspace.openTextDocument({
    content: 'a file of the person, above the strip',
    language: 'plaintext',
  });
  await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.One });
  await pause(400);
  const handle = await gripterm.gateway.create({
    terminalId: TERMINAL_ID as unknown as Spec['terminalId'],
    name,
    cwd: os.tmpdir(),
    env: {},
    shellPath: null,
    shellArgs: [],
  });
  const until = Date.now() + 10000;
  while (columnOf(name) === undefined && Date.now() < until) {
    await pause(200);
  }
  return { handle, column: columnOf(name) };
}

suite('the strip after its last terminal', () => {
  test('does the editor take the empty group away by itself', async () => {
    const gripterm = await api();
    const settings = vscode.workspace.getConfiguration('workbench.editor');
    console.log(`  closeEmptyGroups: ${String(settings.get('closeEmptyGroups'))}`);
    console.log(`  autoLockGroups.terminalEditor: ${String(settings.get<Record<string, boolean>>('autoLockGroups')?.terminalEditor)}`);

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await pause(800);

    const name = 'gripterm-probe-leftover';
    const { handle, column } = await terminalInTheStrip(gripterm, name);
    console.log(`  the terminal went into column ${String(column)}: ${groups()}`);
    assert.notEqual(column, undefined, 'the terminal never reached a group of the editor area');

    handle.dispose();
    for (let look = 1; look <= 6; look += 1) {
      await pause(1000);
      console.log(`  +${String(look)} s after the terminal was disposed: ${groups()}`);
    }
    const stayed = vscode.window.tabGroups.all.some((group) => group.viewColumn === column);
    console.log(
      stayed
        ? '  THE EMPTY GROUP STAYED -- the leftover is made when a terminal closes'
        : '  the editor closed the empty group by itself -- the leftover is not made here'
    );
  });

  test('and it leaves a strip standing for the run that follows', async () => {
    const gripterm = await api();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await pause(800);
    const { column } = await terminalInTheStrip(gripterm, 'gripterm-probe-restart');
    console.log(`  left standing, the terminal in column ${String(column)}: ${groups()}`);
    // Deliberately NOT disposed and NOT closed: what the next run sees is the
    // question. `isTransient` says the terminal will not come back; the group
    // is the half nobody has measured.
  });
});
