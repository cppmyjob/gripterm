import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * The two things the owner said about the panel in the M3.14 acceptance, turned
 * from complaints into measurements.
 *
 * Both were written down as "not checked whose behaviour this is", which is the
 * shape a question has when nobody has run anything:
 *
 *   * "Closing the last ordinary terminal hides the whole panel, our tab with
 *     it." -- what a person loses there is the sight of a live agent, so it
 *     matters whether we do it, the editor does it, or nobody does.
 *   * "The panel is not the height it was after a restart." -- the same question
 *     one level down: a height that WE change is a defect of ours, and a height
 *     the editor restores its own way is a fact to live with and to say out loud.
 *
 * Neither can be asked of the API directly -- there is no `panel.height` and no
 * event for a panel closing. Both are asked through the page instead: the view
 * reports whether it is visible, and it measures its own terminal in ROWS, which
 * is panel height in the only unit that matters to the person looking at an
 * agent. That is also why this suite is here and not in jest: the subject is the
 * editor's own workbench.
 */

const SETTLES_MS = 8000;
const POLL_MS = 100;

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

/** Waits for something on somebody else's schedule; the answer is whether it came. */
async function until(ready: () => boolean, ms = SETTLES_MS): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !ready()) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return ready();
}

/** Long enough for the editor to have done a thing it does not announce. */
async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Our view, open and with a page in it that has answered at least once. */
async function shownPanel(): Promise<GriptermApi['workbench']> {
  const { workbench } = await api();
  workbench.reveal(true);
  await workbench.whenReady();
  assert.equal(await until(() => workbench.visible), true, 'our view never became visible');
  return workbench;
}

suite('the panel our tab lives in', () => {
  test('goes away when the editor takes its last ordinary terminal away, and it is the editor doing it', async () => {
    const workbench = await shownPanel();

    // The measurement needs to be the LAST terminal, or it measures nothing: a
    // panel with another terminal still in it has no reason to close.
    //
    // WAITED FOR rather than asserted outright, and that is a measured lesson of
    // its own: `engine-fallback` runs just before this file, makes two terminals
    // of the editor's and disposes them, and `window.terminals` does not empty in
    // the same tick. One run in three failed here before this wait went in.
    const gone = await until(() => vscode.window.terminals.length === 0);
    assert.equal(
      gone,
      true,
      `a terminal was still open when this began: ${vscode.window.terminals.map((one) => one.name).join(', ')}`
    );

    const terminal = vscode.window.createTerminal({ name: 'gripterm-panel-probe' });
    terminal.show(false);
    assert.equal(
      await until(() => !workbench.visible),
      true,
      'the editor did not switch the panel to its own terminal, so nothing below is a measurement'
    );

    terminal.dispose();
    await pause(2500);

    // What is being recorded here is the EDITOR'S answer, whatever it is: this
    // window closes no panel and reveals none on a terminal it did not make.
    // The value is asserted rather than logged so that the day it changes, the
    // change is read here and not in somebody's acceptance run.
    assert.equal(
      workbench.visible,
      false,
      'the editor now brings our tab back when its own last terminal goes -- that is new, and better'
    );
  });

  test('keeps the height a person gave it when we open it ourselves', async () => {
    const workbench = await shownPanel();
    const before = await workbench.measure('panel height, before the panel was closed');

    // The panel closed the ordinary way, and opened again the way a RESTORE
    // opens it -- which is the moment the owner's complaint is about (M3 plan
    // 0.2: "восстановление открывает панель").
    await vscode.commands.executeCommand('workbench.action.closePanel');
    assert.equal(await until(() => !workbench.visible), true, 'the panel would not close');
    workbench.reveal(true);
    assert.equal(await until(() => workbench.visible), true, 'the panel would not open again');
    const after = await workbench.measure('panel height, after we opened it ourselves');

    // Rows and not pixels: rows are what the agent's TUI is laid out in, and a
    // panel that came back two rows shorter is the complaint in its own units.
    assert.equal(
      after.rows,
      before.rows,
      `our own reveal changed the height of the panel: ${String(before.rows)} rows before, ${String(after.rows)} after`
    );
  });
});
