import {
  askTheClipboard,
  underTheClipboard,
} from './integration/clipboard-of-this-window';
import type { ClipboardDoor, ClipboardVerdict } from './integration/clipboard-of-this-window';

/**
 * The one thing the keyboard suite needs and does not own: the clipboard of the
 * machine it runs on.
 *
 * **Why this exists at all.** Five tests of `tests/integration/terminal-keyboard`
 * cross the clipboard -- copy puts a selection on it, paste takes text off it --
 * and on Windows the clipboard belongs to the interactive DESKTOP rather than to
 * a process. Measured 2026-08-24 on this machine, with the lock screen up:
 * `OpenClipboard` answers `ERROR_ACCESS_DENIED` (5) with no other window holding
 * it, and `vscode.env.clipboard.readText()` inside the running Extension Host
 * reads back empty after its own `writeText`. The same five tests then failed as
 * if the product had lost its paste, and the other six -- which touch no
 * clipboard -- passed in a second and a half each.
 *
 * That is a fact about the ROOM, and no amount of asking a view to take the
 * keyboard changes it. So the suite measures the room before it blames the
 * build, and this is the rule it measures by.
 *
 * **The one property that makes it safe.** The measurement goes through the
 * EDITOR's own clipboard -- the same object the extension is handed -- and never
 * through our page, our channel or our command. So a clipboard that is there and
 * a product that has lost it still comes out RED; only a clipboard that is not
 * there at all comes out refused. A detector that measured our own road would be
 * a detector that switched the tests off the day they started catching things.
 */

/** A clipboard that keeps what it is given, which is what a machine nobody has locked does. */
class WorkingDoor implements ClipboardDoor {
  public held: string;

  constructor(held: string) {
    this.held = held;
  }

  public read = async (): Promise<string> => await Promise.resolve(this.held);

  public write = async (text: string): Promise<void> => {
    this.held = text;
    await Promise.resolve();
  };
}

/**
 * A clipboard that swallows every write and reads back empty.
 *
 * Not an invention: this is what `vscode.env.clipboard` did in the run of
 * 2026-08-24 with the workstation locked -- `writeText` resolved, and the
 * `readText` after it gave `""`.
 */
class LockedDoor implements ClipboardDoor {
  public read = async (): Promise<string> => await Promise.resolve('');

  public write = async (_text: string): Promise<void> => {
    // Swallowed, exactly as a locked machine swallows it.
    await Promise.resolve();
  };
}

const NONCE = 'gripterm asking whether this window has a clipboard';

describe('whether the clipboard of this window is really there', () => {
  it('says it is, when a nonce written through the door comes back through it', async () => {
    const door = new WorkingDoor('what the person was carrying');

    const verdict = await askTheClipboard(door, NONCE);

    expect(verdict.ours).toBe(true);
    expect(verdict.refusal).toBe('');
  });

  it('puts back what the person was carrying, because this runs on their machine', async () => {
    const door = new WorkingDoor('what the person was carrying');

    await askTheClipboard(door, NONCE);

    expect(door.held).toBe('what the person was carrying');
  });

  it('refuses when the write is swallowed, which is a locked workstation', async () => {
    const door = new LockedDoor();

    const verdict = await askTheClipboard(door, NONCE);

    expect(verdict.ours).toBe(false);
    // The sentence has to NAME the condition, or a person reading a red run
    // learns only that something is wrong somewhere.
    expect(verdict.refusal).toContain('clipboard');
    expect(verdict.refusal).toContain('locked');
    // And it has to carry the measurement, or it is one more thing to take on
    // trust: what was written, and what came back instead.
    expect(verdict.refusal).toContain(NONCE);
  });

  it('refuses rather than throwing when the clipboard cannot be read at all', async () => {
    const door: ClipboardDoor = {
      read: async () => await Promise.reject(new Error('OpenClipboard: access denied')),
      write: async () => { await Promise.resolve(); },
    };

    const verdict = await askTheClipboard(door, NONCE);

    expect(verdict.ours).toBe(false);
    expect(verdict.refusal).toContain('OpenClipboard: access denied');
  });

  it('refuses rather than throwing when the clipboard cannot be written', async () => {
    const door: ClipboardDoor = {
      read: async () => await Promise.resolve('what the person was carrying'),
      write: async () => { await Promise.reject(new Error('OpenClipboard: access denied')); },
    };

    const verdict = await askTheClipboard(door, NONCE);

    expect(verdict.ours).toBe(false);
    expect(verdict.refusal).toContain('OpenClipboard: access denied');
  });
});

describe('a test that needs the clipboard, and what happens when the room has not got one', () => {
  const there: ClipboardVerdict = { ours: true, refusal: '' };
  const gone: ClipboardVerdict = { ours: false, refusal: 'the clipboard is locked away' };

  /** Stands in for Mocha's own `this.skip()`, which does not return either. */
  function refusing(said: string[]): (verdict: ClipboardVerdict) => never {
    return (verdict) => {
      said.push(verdict.refusal);
      throw new Error(`REFUSED: ${verdict.refusal}`);
    };
  }

  it('runs the test when the clipboard is there', async () => {
    const said: string[] = [];
    let ran = 0;

    await underTheClipboard(
      async () => await Promise.resolve(there),
      refusing(said),
      async () => { ran += 1; await Promise.resolve(); }
    );

    expect(ran).toBe(1);
    expect(said).toEqual([]);
  });

  it('refuses before the test runs when the clipboard is already gone', async () => {
    const said: string[] = [];
    let ran = 0;

    await expect(underTheClipboard(
      async () => await Promise.resolve(gone),
      refusing(said),
      async () => { ran += 1; await Promise.resolve(); }
    )).rejects.toThrow('REFUSED: the clipboard is locked away');

    // Not run at all, which is the point: these tests spend thirty seconds each
    // waiting for something that cannot arrive.
    expect(ran).toBe(0);
  });

  it('lets the failure out when the clipboard was there the whole time', async () => {
    const said: string[] = [];

    await expect(underTheClipboard(
      async () => await Promise.resolve(there),
      refusing(said),
      async () => { await Promise.reject(new Error('the paste never arrived')); }
    )).rejects.toThrow('the paste never arrived');

    // THE property this whole thing has to keep: a clipboard that was there and
    // a build that lost the paste is RED, and stays red.
    expect(said).toEqual([]);
  });

  it('refuses instead when the clipboard went away while the test was running', async () => {
    // The unattended case: the gate starts on an unlocked machine and the screen
    // lock timer fires four minutes in. Nothing about the build changed.
    const said: string[] = [];
    const answers = [there, gone];

    await expect(underTheClipboard(
      async () => await Promise.resolve(answers.shift() ?? gone),
      refusing(said),
      async () => { await Promise.reject(new Error('the paste never arrived')); }
    )).rejects.toThrow('REFUSED: the clipboard is locked away');

    expect(said).toEqual(['the clipboard is locked away']);
  });
});
