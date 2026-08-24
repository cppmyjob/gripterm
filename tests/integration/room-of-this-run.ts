/**
 * The room this run is really in, asked through the EDITOR's own doors.
 *
 * One place rather than one per suite, because two suites need the same
 * conditions and a second copy of a door is a second thing to keep true. What
 * lives here is only the wiring: the rules are in `clipboard-of-this-window`,
 * `keyboard-of-this-window` and `room-this-runs-in`, none of which imports
 * `vscode`, all of which are held by jest.
 *
 * **Every door below belongs to the editor, never to us.** The clipboard is
 * `vscode.env.clipboard` -- the object the extension is handed -- and the
 * keyboard is `vscode.window.state.focused`, the editor's answer about the
 * editor's own window. Neither is our page, our view, our channel or our
 * command. That is what keeps a refusal from being able to hide a defect: a
 * room that gives this suite what it needs, and a build that has lost its paste
 * or its focus handling, still comes out RED.
 */

import * as vscode from 'vscode';
import { announceRefusal, underTheRoom } from './room-this-runs-in';
import { askTheClipboard } from './clipboard-of-this-window';
import { askTheKeyboard } from './keyboard-of-this-window';
import type { AskTheRoom, RoomVerdict } from './room-this-runs-in';
import type { ClipboardDoor } from './clipboard-of-this-window';
import type { KeyboardDoor } from './keyboard-of-this-window';

/**
 * The EDITOR's clipboard, which is the one the extension is handed.
 *
 * Deliberately not our page, our channel or our command: this is what the tests
 * are measured AGAINST, so a build that has lost its paste on a machine whose
 * clipboard works must still come out red. Only a machine with no clipboard to
 * give comes out refused.
 */
const EDITORS_CLIPBOARD: ClipboardDoor = {
  read: async () => await vscode.env.clipboard.readText(),
  write: async (text) => { await vscode.env.clipboard.writeText(text); },
};

/**
 * The EDITOR's own answer about the EDITOR's own window.
 *
 * `focused` and deliberately not `active`: measured 2026-08-24, with a second
 * window in this window's UI thread holding the keyboard, `state.active` stayed
 * `true` while `state.focused`, the page's `document.hasFocus()` and the host's
 * `keyboard.focused` all went false together -- and came back together when it
 * was closed. `active` is about the application; `focused` is about the window,
 * and the window is what a key press needs.
 */
const EDITORS_WINDOW: KeyboardDoor = {
  holdsTheKeyboard: () => vscode.window.state.focused,
  rest: async (ms) => { await new Promise<void>((resolve) => { setTimeout(resolve, ms); }); },
};

/** Whether this window holds the keyboard. Declared first: it costs nothing. */
export const theKeyboard: AskTheRoom = async () => await askTheKeyboard(EDITORS_WINDOW);

/** Whether this machine will give this suite its clipboard. */
export const theClipboard: AskTheRoom = async () => await askTheClipboard(EDITORS_CLIPBOARD);

/**
 * Declares a test that cannot work unless the room gives it these things.
 *
 * Declared this way rather than checked inside each body, so that WHICH tests
 * depend on the room is visible in the source at the point where they are named.
 * When the room is whole this is `test` and nothing else; when it is not, the
 * test is REFUSED with the condition named -- neither passed nor failed.
 */
export function testNeeding(
  needs: readonly AskTheRoom[],
  title: string,
  body: () => Promise<void>
): void {
  test(title, async function (this: Mocha.Context) {
    await underTheRoom(
      needs,
      (verdict: RoomVerdict): never => {
        announceRefusal(verdict.refusal);
        return this.skip();
      },
      body
    );
  });
}
