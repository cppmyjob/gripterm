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

/**
 * How long the page is given to report a layout change before it is taken to
 * have none to report.
 *
 * Measured 2026-08-25, ten reveals of the panel: the page's own report of the
 * reveal lands 130 to 163 ms after the view becomes visible. This is three
 * times the longest of those, and it is a ceiling on OUR OWN timer rather than
 * a guess about the editor's -- the page re-fits and reports eighty
 * milliseconds after its box stops moving (`SETTLE_MS`,
 * `packages/webview/src/page/main.ts`).
 */
const STILL_MS = 500;

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

/**
 * The size the panel has SETTLED at, rather than one it is passing through.
 *
 * **What this replaces was a bet, and it is worth naming as one.** Until
 * 2026-08-25 this helper took two answers a hundred milliseconds apart agreeing
 * with each other. That is not a wait; it is a wager that the panel finishes
 * laying out inside a hundred milliseconds -- somebody else's schedule -- and it
 * is a wager that loses precisely under load, which is why it lost in the full
 * live run and not on its own: three runs of the `own` label by itself were
 * green here on 2026-08-25, and the register of the two days before it records
 * four reds of the full run against at least three greens.
 *
 * **Why the bet could be lost at all, measured the same day over ten reveals.**
 * In NINE of the ten, the page went on answering a size it was not at for 89 to
 * 147 ms after the view became visible -- `cols` and `rows` are xterm's and move
 * only when something re-fits it, while the box they are supposed to describe
 * had already moved. Two answers a hundred milliseconds apart both land inside a
 * window that wide, agree, and are wrong together. That half is now fixed where
 * it belonged, in the page (`case 'measure'` in
 * `packages/webview/src/page/main.ts`): the same ten reveals afterwards have no
 * wrong answer in them at all, over some seven hundred samples.
 *
 * **What is waited for instead: a named event.** The page reports a layout
 * change of its own accord, and only after it has re-fitted. So a size is
 * settled when the page's own report agrees with the size asked for here -- and
 * it is settled just as well when the page has nothing to report, because then
 * nothing has moved since the measurement was taken. Both ceilings are named:
 * `STILL_MS` for one report, `SETTLES_MS` for the whole wait.
 */
async function settledSize(
  workbench: GriptermApi['workbench'],
  because: string
): Promise<{ readonly cols: number, readonly rows: number }> {
  const deadline = Date.now() + SETTLES_MS;
  // Laid out and fitted before it is answered, so this is the size the page IS
  // at rather than the size something last resized it to.
  let size = await workbench.measure(because);
  const seen = [`${String(size.cols)}x${String(size.rows)}`];
  while (Date.now() < deadline) {
    // Nothing can slip between the answer above and this wait: the host settles
    // a waiter from inside the callback that heard the message, and the line
    // below runs in the microtask after it -- before any further message.
    const heard = await workbench.nextMeasurement(STILL_MS).then((report) => report, () => null);
    if (heard === null || (heard.cols === size.cols && heard.rows === size.rows)) {
      return { cols: size.cols, rows: size.rows };
    }
    size = heard;
    seen.push(`${String(size.cols)}x${String(size.rows)}`);
  }
  throw new Error(`the panel never stopped moving (${because}): ${seen.join(' -> ')}`);
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
    const before = await settledSize(workbench, 'panel height, before the panel was closed');

    // The panel closed the ordinary way, and opened again the way a RESTORE
    // opens it -- which is the moment the owner's complaint is about (M3 plan
    // 0.2: "восстановление открывает панель").
    await vscode.commands.executeCommand('workbench.action.closePanel');
    assert.equal(await until(() => !workbench.visible), true, 'the panel would not close');
    workbench.reveal(true);
    assert.equal(await until(() => workbench.visible), true, 'the panel would not open again');
    const after = await settledSize(workbench, 'panel height, after we opened it ourselves');

    // Rows and not pixels: rows are what the agent's TUI is laid out in, and a
    // panel that came back two rows shorter is the complaint in its own units.
    assert.equal(
      after.rows,
      before.rows,
      `our own reveal changed the height of the panel: ${String(before.cols)}x${String(before.rows)} before, ` +
      `${String(after.cols)}x${String(after.rows)} after`
    );
  });
});
