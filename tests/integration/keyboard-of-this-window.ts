/**
 * Whether the window this suite runs in holds the keyboard, and what to say when
 * it does not.
 *
 * **The condition, named.** Eleven tests across `terminal-keyboard` and
 * `terminal-details` wait for a key press dispatched on the page to reach the
 * terminal. For that the WINDOW has to hold the keyboard: the page's key event
 * is forwarded out of the webview, the editor matches a keybinding against it
 * and runs our command, and none of that happens in a window the operating
 * system is not sending input to. Two rooms take it away and neither is
 * recoverable from inside a test:
 *
 *   * **the workstation locks WHILE the run is going.** The desktop switch takes
 *     the focus from whatever had it and does not give it back until somebody
 *     unlocks;
 *   * **another application holds the foreground** -- measured 2026-08-18, with
 *     a person at the keyboard the foreground belonged to their browser and
 *     their other editor for four fifths of a run.
 *
 * **What a locked workstation is NOT.** Measured 2026-08-24 on this machine with
 * the workstation locked the whole time (`LogonUI` and `LockApp` up,
 * `GetForegroundWindow()` returning `NULL` -- process id 0):
 *
 *   * all eleven tests of `terminal-keyboard` pass, in 22 seconds;
 *   * `vscode.window.state.focused`, `document.hasFocus()` inside the page and
 *     `keyboard.focused` all read `true` for 40 samples a second apart;
 *   * a second editor started beside the host does not take the keyboard from
 *     it, and neither does a top-most window calling `SetForegroundWindow` --
 *     on a locked desktop the focus is frozen where it was, and
 *     `OpenClipboard` succeeds.
 *
 * So "the machine is locked" is the WRONG condition, and a detector built on it
 * would have refused a room in which every one of those tests passes. The right
 * one is the narrow thing the tests actually need, asked of the window itself.
 *
 * **Why the measurement goes through the editor's own window state.** The door
 * handed in below is `vscode.window.state.focused` -- the editor's answer about
 * the editor's window -- and never our page, our view or our command. A window
 * that holds the keyboard and a build that has lost its focus handling therefore
 * still comes out RED; only a window that has not got the keyboard at all comes
 * out refused. Measured 2026-08-24, with a second window in this window's own UI
 * thread taking the keyboard: `window.state.focused`, the page's
 * `document.hasFocus()` and the host's `keyboard.focused` go false together and
 * come back together, and `window.state.active` stays true throughout -- which
 * is why `active` is not the door.
 */

import type { RoomVerdict } from './room-this-runs-in';

/** The window, as the one question this needs of it. `vscode.window.state` is one. */
export interface KeyboardDoor {
  /** Whether the EDITOR says its own window holds the keyboard right now. */
  readonly holdsTheKeyboard: () => boolean;
  /** Waits, so that "it never came back" is measured over time and not at a point. */
  readonly rest: (ms: number) => Promise<void>;
}

/**
 * How many times the window is asked before the room is blamed, and how long
 * apart.
 *
 * Patience rather than one sample, and it is not politeness: starting a console
 * process on Windows takes the foreground for a moment -- that is why
 * `keyboardIntoTerminal` retries at all -- so a detector reading a single sample
 * would refuse rooms that run this suite perfectly well. Two seconds is far past
 * anything that flickers and far short of the thirty seconds a test spends
 * waiting for a keyboard that is never coming.
 */
export const LOOKS = 8;
export const LOOK_EVERY_MS = 250;

/**
 * The refusal, in one place so that every road to it says the same thing.
 *
 * It carries the measurement AND the thing the measurement ruled out, because
 * the obvious reading of this failure is the wrong one: whoever reads it will
 * think "the machine was locked, that will be it", and a machine locked before
 * the run starts is a machine on which all eleven of these tests pass.
 */
function refusalSaying(what: string): string {
  return (
    'THIS SUITE NEEDS THE KEYBOARD OF THE WINDOW IT RUNS IN, AND THIS WINDOW HAS ' +
    `NOT GOT IT: ${what}. ` +
    'These tests press a key on the page and wait for the byte at the far end of a ' +
    'pty; the press is forwarded out of the webview and matched against a ' +
    'keybinding by the editor, and none of that happens in a window the operating ' +
    'system is not sending input to. Two rooms take it away and no extension can ' +
    'take it back: the workstation LOCKS while the run is going -- the desktop ' +
    'switch takes the focus and holds it until somebody unlocks -- or another ' +
    'application has the foreground, which is what a person sitting at this ' +
    'machine looks like from in here. A workstation locked BEFORE the run starts ' +
    'is NOT this condition and must not be read as it: measured 2026-08-24, with ' +
    'the lock screen up and no foreground window on the desktop at all, this ' +
    'window kept the keyboard and all eleven tests passed in 22 seconds. This is ' +
    'the ROOM and not the build: run the gate on a machine nobody is using, and ' +
    'leave it alone while it runs.'
  );
}

/**
 * Asks the window whether it holds the keyboard, by asking the editor about
 * itself.
 *
 * Measured rather than deduced from the lock state, the foreground window or the
 * session -- every one of those is a proxy, and two of them are measurably wrong
 * on this machine: while it is locked there is no foreground window at all and
 * the suite passes anyway.
 */
export async function askTheKeyboard(
  door: KeyboardDoor,
  looks: number = LOOKS,
  everyMs: number = LOOK_EVERY_MS
): Promise<RoomVerdict> {
  for (let look = 0; look < looks; look += 1) {
    let holds: boolean;
    try {
      holds = door.holdsTheKeyboard();
    } catch (cause: unknown) {
      return { ours: false, refusal: refusalSaying(`asking the editor raised ${String(cause)}`) };
    }
    if (holds) {
      return { ours: true, refusal: '' };
    }
    if (look + 1 < looks) {
      await door.rest(everyMs);
    }
  }
  return {
    ours: false,
    refusal: refusalSaying(
      `the editor says its window does not hold the keyboard, and it did not take it back ` +
      `in ${String(looks)} looks over ${String((looks - 1) * everyMs)} ms`
    ),
  };
}

/**
 * Whose fault it is that a press never reached the terminal, in one sentence.
 *
 * Here rather than at the `throw`, and with tests, because the sentence it
 * replaces was WRONG in the case that matters most. The wait read
 * `document.hasFocus()` in the page and said "THE EDITOR WINDOW DOES NOT HOLD
 * THE KEYBOARD" whenever it was false -- but the page's document has the
 * keyboard only when the editor has also given it to the WEBVIEW, so a panel our
 * own build failed to reveal printed a sentence blaming the room. That is how a
 * defect gets read as a locked screen, which is the whole subject of this file.
 *
 * The two facts are separate on purpose: `windowHoldsIt` is the editor's answer
 * about its own window and belongs to the room; `pageHasIt` is our page, and
 * everything it says is ours to answer for.
 */
export function whyTheKeyboardIsElsewhere(windowHoldsIt: boolean, pageHasIt: boolean): string {
  if (!windowHoldsIt) {
    return (
      'THE WINDOW THIS RUN IS IN DOES NOT HOLD THE KEYBOARD, and no view can ask ' +
      'for what its window has not got. That is the ROOM: something else on this ' +
      'machine has the foreground, or the workstation locked while this was ' +
      'running. Run the gate on a machine nobody is using and leave it alone. '
    );
  }
  if (!pageHasIt) {
    return (
      'This window HOLDS the keyboard and our page has not got it, so the editor ' +
      'never gave it to the webview: the panel was not revealed, or the view ' +
      'refused the focus. That is ours to answer for, and it is not the room. '
    );
  }
  return 'The page has the keyboard and the terminal did not take it, which is ours to answer for. ';
}
