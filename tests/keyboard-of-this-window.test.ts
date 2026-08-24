import {
  askTheKeyboard,
  LOOKS,
  LOOK_EVERY_MS,
  whyTheKeyboardIsElsewhere,
} from './integration/keyboard-of-this-window';
import type { KeyboardDoor } from './integration/keyboard-of-this-window';

/**
 * The other thing the keyboard suite needs and does not own: the keyboard of the
 * window it runs in.
 *
 * **Why this exists beside the clipboard one.** On 2026-08-24 a full `own` run
 * went eleven red, and the eleven were exactly the tests that wait for
 * `keyboard.focused` -- five chord tests and five clipboard tests of
 * `terminal-keyboard`, plus `redrawing the half does not take the keyboard out
 * of the terminal` in `terminal-details`, which builds no terminal of its own
 * and shares nothing with the other ten except that wait. Every test in both
 * files that does not wait for the keyboard passed. The clipboard detector was
 * asked, answered "the clipboard is ours", and was right to: the same suite run
 * again on the same locked machine passes all eleven in 22 seconds.
 *
 * So the condition is neither the clipboard nor the lock. It is that THIS WINDOW
 * DOES NOT HOLD THE KEYBOARD, and the two ways a room does that are a
 * workstation that locks WHILE the run is going (the desktop switch takes the
 * focus and will not give it back until somebody unlocks) and another
 * application holding the foreground -- the 2026-08-18 measurement, where a
 * person at the keyboard kept the foreground on their browser for four fifths of
 * a run.
 *
 * **What is measured and what is not.** Measured 2026-08-24 on this machine,
 * workstation LOCKED the whole time (`LogonUI` and `LockApp` up,
 * `GetForegroundWindow()` returning `NULL` with process id 0):
 *
 *   * all eleven tests of `terminal-keyboard` pass, in 22 s;
 *   * `vscode.window.state.focused`, `document.hasFocus()` in the page and
 *     `keyboard.focused` read `true` for every one of 40 samples a second apart;
 *   * a whole second editor started beside the host does NOT take the keyboard
 *     from it, and neither does a top-most window calling
 *     `SetForegroundWindow` -- on a locked desktop the focus is frozen where it
 *     was.
 *
 * A locked workstation is therefore a GOOD room for this suite, and a detector
 * that refused one would have switched eleven passing tests off. That is the
 * mistake this file exists to not make.
 *
 * **The one property that makes it safe**, and it is the clipboard detector's
 * property: the door is the EDITOR's own answer about its own window
 * (`vscode.window.state.focused`), never our page, our view or our command. A
 * build that has lost its focus handling in a window that holds the keyboard
 * still comes out RED; only a window that has not got the keyboard at all comes
 * out refused.
 */

/** A door that answers from a script, and counts how long it was asked to wait. */
class ScriptedDoor implements KeyboardDoor {
  public rested: number[] = [];
  private readonly _answers: boolean[];
  private readonly _andThen: boolean;

  constructor(answers: boolean[], andThen: boolean) {
    this._answers = [...answers];
    this._andThen = andThen;
  }

  public holdsTheKeyboard = (): boolean => this._answers.shift() ?? this._andThen;

  public rest = async (ms: number): Promise<void> => {
    this.rested.push(ms);
    await Promise.resolve();
  };
}

describe('whether the window this suite runs in holds the keyboard', () => {
  it('says it does, when the editor says its window has it', async () => {
    const door = new ScriptedDoor([], true);

    const verdict = await askTheKeyboard(door);

    expect(verdict.ours).toBe(true);
    expect(verdict.refusal).toBe('');
  });

  it('asks once and stops, when the answer is yes at the first look', async () => {
    // The cost of the detector on a passing run, and it has to be nothing: this
    // runs in front of every test of the suite.
    const door = new ScriptedDoor([], true);

    await askTheKeyboard(door);

    expect(door.rested).toEqual([]);
  });

  it('waits for the window to take the keyboard back rather than refusing at once', async () => {
    // Not patience for its own sake. Starting a console process on Windows takes
    // the foreground for a moment -- it is why `keyboardIntoTerminal` retries at
    // all -- and a detector that read one sample would refuse a room that is
    // perfectly able to run this suite.
    const door = new ScriptedDoor([false, false, true], false);

    const verdict = await askTheKeyboard(door);

    expect(verdict.ours).toBe(true);
    expect(door.rested).toEqual([LOOK_EVERY_MS, LOOK_EVERY_MS]);
  });

  it('refuses when the window never gets the keyboard, and names the condition', async () => {
    const door = new ScriptedDoor([], false);

    const verdict = await askTheKeyboard(door);

    expect(verdict.ours).toBe(false);
    // A refusal that does not NAME what is wrong teaches a reader only that
    // something is, somewhere.
    expect(verdict.refusal).toContain('keyboard');
    expect(verdict.refusal).toContain('locks');
    expect(verdict.refusal).toContain('foreground');
    // And it carries the measurement, so that nobody reads it as "the machine is
    // locked, that will be it" -- which is the wrong answer, measured.
    expect(verdict.refusal).toContain('locked BEFORE');
  });

  it('looks the whole number of times before it refuses', async () => {
    const door = new ScriptedDoor([], false);

    await askTheKeyboard(door);

    expect(door.rested).toHaveLength(LOOKS - 1);
  });

  it('refuses rather than throwing when the editor cannot answer at all', async () => {
    const door: KeyboardDoor = {
      holdsTheKeyboard: () => { throw new Error('the window is gone'); },
      rest: async () => { await Promise.resolve(); },
    };

    const verdict = await askTheKeyboard(door);

    expect(verdict.ours).toBe(false);
    expect(verdict.refusal).toContain('the window is gone');
  });
});

/*
 * The sentence a failed focus wait prints, and why it is a function with tests
 * rather than a string built where it is thrown.
 *
 * The wait blamed THE ROOM from `document.hasFocus()` alone. That reading is
 * right for a window nobody is sending input to and wrong for every other way
 * the page can be without the keyboard -- including a panel our own build failed
 * to reveal, which is a defect and would have been printed as "something else on
 * this machine has the keyboard". A diagnostic that sends the reader to the
 * wrong half of the system is how 2026-08-24 cost a day twice.
 */
describe('what a failed wait for the keyboard says about whose fault it is', () => {
  it('blames the room only when the WINDOW has not got the keyboard', () => {
    const said = whyTheKeyboardIsElsewhere(false, false);

    expect(said).toContain('THE WINDOW');
    expect(said).toContain('ROOM');
    expect(said).not.toContain('ours');
  });

  it('blames us when the window has the keyboard and the page has not', () => {
    // The panel was never revealed, or the view refused the focus. Both ours.
    const said = whyTheKeyboardIsElsewhere(true, false);

    expect(said).toContain('ours');
    expect(said).not.toContain('ROOM');
  });

  it('blames us when the page has the keyboard and the terminal did not take it', () => {
    const said = whyTheKeyboardIsElsewhere(true, true);

    expect(said).toContain('ours');
    expect(said).not.toContain('ROOM');
  });

  it('tells those two ours-es apart, because they are different places to look', () => {
    expect(whyTheKeyboardIsElsewhere(true, false)).not.toEqual(whyTheKeyboardIsElsewhere(true, true));
  });
});
