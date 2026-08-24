/**
 * Whether the clipboard this suite needs is really there, and what to say when
 * it is not.
 *
 * **The condition, named.** On Windows the clipboard belongs to the interactive
 * DESKTOP, not to a process. While the workstation is locked, every process on
 * that desktop is refused it: `OpenClipboard` answers `ERROR_ACCESS_DENIED` (5)
 * with `GetOpenClipboardWindow()` reporting no holder at all, and Electron --
 * and therefore `vscode.env.clipboard` -- swallows the write and reads back an
 * empty string without raising anything. A disconnected remote session and
 * another application holding the clipboard open do the same.
 *
 * Measured 2026-08-24, on this machine, with `out/tests/integration/terminal-keyboard.js`
 * running under `npx vscode-test`: the foreground window was `LockApp`
 * ("Windows Default Lock Screen"), `OpenClipboard` gave error 5, and the five
 * tests of that suite which cross the clipboard failed after thirty seconds
 * each -- one of them reporting `the clipboard holds ""` immediately after
 * writing to it. The other six, which touch no clipboard, passed in about a
 * second and a half each, and the keyboard reached the terminal in every one of
 * the eleven. So this is NOT the editor's focus and NOT the product; it is the
 * room, and nothing an extension can do reaches it.
 *
 * **Why the measurement goes through the editor's own clipboard.** The door
 * handed in below is `vscode.env.clipboard` -- the same object the extension is
 * given -- and never our page, our channel or our command. A clipboard that is
 * there and a build that has lost its paste therefore still comes out RED. Only
 * a clipboard that is not there at all comes out refused. A detector that
 * measured our own road would be a detector that switched these tests off on the
 * day they started catching something.
 *
 * **Why a refusal and not a red.** These runs are meant to go unattended, with a
 * person using the machine for something else. A gate that turns red because
 * somebody's screen locked teaches everybody to ignore it, and an ignored gate
 * is worse than none. So: red means the product, and a refusal means the room --
 * out loud, with the condition named, never in silence.
 */

/** The clipboard, as the two calls this needs of it. `vscode.env.clipboard` is one. */
export interface ClipboardDoor {
  readonly read: () => Promise<string>;
  readonly write: (text: string) => Promise<void>;
}

export interface ClipboardVerdict {
  /** Whether a nonce written through the door came back through it. */
  readonly ours: boolean;
  /** What to say when it did not. Empty when it did. */
  readonly refusal: string;
}

/**
 * The nonce, and it is a sentence rather than a number for a reason: it lands on
 * the clipboard of whoever owns this machine for a few milliseconds, and if
 * anything ever pastes it, it should say what it was.
 */
export const CLIPBOARD_NONCE = 'gripterm asking whether this window has a clipboard';

/**
 * The refusal, in one place so that every road to it says the same thing.
 *
 * It carries the measurement -- what was written, what came back -- because a
 * refusal a reader has to take on trust is one more thing to check rather than
 * one thing fewer.
 */
function refusalSaying(what: string): string {
  return (
    'THIS SUITE NEEDS THE CLIPBOARD OF THE MACHINE IT RUNS ON, AND THIS MACHINE ' +
    `WOULD NOT GIVE IT: ${what}. ` +
    'On Windows the clipboard belongs to the interactive desktop rather than to a ' +
    'process, so a LOCKED workstation takes it from everything running on that ' +
    'desktop -- as does a disconnected remote session, and another application ' +
    'holding the clipboard open. Measured 2026-08-24 with the lock screen up: ' +
    'OpenClipboard answers ERROR_ACCESS_DENIED with no other window holding it, ' +
    'and vscode.env.clipboard reads back empty after its own write. Nothing in an ' +
    'extension can take that back. This is the ROOM and not the build: unlock the ' +
    'machine, leave it unlocked, and run the gate again.'
  );
}

/**
 * Asks the clipboard whether it is there, by using it.
 *
 * Measured rather than deduced from the lock state, the foreground window or the
 * session: those are proxies, and each of them is wrong somewhere. A window that
 * is not in the foreground has a perfectly good clipboard; a locked one does
 * not. The thing the tests need is the round trip, so the round trip is what is
 * asked.
 *
 * What the person was carrying is read first and put back last. This runs on
 * their machine.
 */
export async function askTheClipboard(
  door: ClipboardDoor,
  nonce: string = CLIPBOARD_NONCE
): Promise<ClipboardVerdict> {
  let theirs = '';
  try {
    theirs = await door.read();
  } catch (cause: unknown) {
    return { ours: false, refusal: refusalSaying(`reading it raised ${String(cause)}`) };
  }

  try {
    await door.write(nonce);
  } catch (cause: unknown) {
    return { ours: false, refusal: refusalSaying(`writing to it raised ${String(cause)}`) };
  }

  let back: string;
  try {
    back = await door.read();
  } catch (cause: unknown) {
    return { ours: false, refusal: refusalSaying(`reading it back raised ${String(cause)}`) };
  } finally {
    // Their text, put back on every road out of here -- including the ones that
    // refuse. A suite that eats somebody's clipboard has taken something from
    // them that it cannot give back later.
    await door.write(theirs).catch(() => undefined);
  }

  if (back === nonce) {
    return { ours: true, refusal: '' };
  }
  return {
    ours: false,
    refusal: refusalSaying(`${JSON.stringify(nonce)} was written to it and ${JSON.stringify(back)} came back`),
  };
}

/**
 * Runs a test that cannot work without the clipboard, and refuses instead of
 * failing when the clipboard is not there.
 *
 * Asked TWICE, and the second time is the whole reason this is a function rather
 * than a `suiteSetup`. The gate is meant to run unattended while somebody uses
 * the machine, so the screen lock timer can fire in the middle of it: a suite
 * that only checked at the start would start green and go red four minutes in,
 * with nothing about the build having changed. The second ask happens only on
 * the way out of a failure, so it costs nothing on a passing run.
 *
 * `refuse` never returns -- Mocha's own `this.skip()` does not either -- so a
 * refusal cannot be mistaken for a pass by anything downstream of it.
 */
export async function underTheClipboard(
  ask: () => Promise<ClipboardVerdict>,
  refuse: (verdict: ClipboardVerdict) => never,
  body: () => Promise<void>
): Promise<void> {
  const before = await ask();
  if (!before.ours) {
    refuse(before);
  }
  try {
    await body();
  } catch (cause: unknown) {
    const after = await ask();
    if (!after.ours) {
      refuse(after);
    }
    // The clipboard was there before and it is there now, so whatever went wrong
    // in between is ours to answer for.
    throw cause;
  }
}
