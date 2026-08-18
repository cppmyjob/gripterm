import { TERMINAL_CHORDS, chordById, chordFor, isCopyPress, isPastePress } from '../../packages/webview/src/keys';
import type { KeyPress } from '../../packages/webview/src/keys';

/**
 * The one list of chords a terminal of ours takes from the editor.
 *
 * What is tested here is a table and two lookups, and it earns its own file for
 * one reason: this table is the ONLY place the two sides agree. The manifest
 * contributes these chords to the editor, the page refuses to handle them
 * itself, and the command turns them into bytes -- three readers of one list.
 * The integration suite checks the manifest against it; this checks the list
 * itself is what a terminal means by those keys.
 */

function press(code: string, held: Partial<KeyPress> = {}): KeyPress {
  return { code, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, ...held };
}

describe('the chords a terminal takes for itself', () => {
  it('are the six the owner named, and no others', () => {
    expect(TERMINAL_CHORDS.map((chord) => chord.id)).toStrictEqual([
      'ctrl+b',
      'ctrl+j',
      'ctrl+p',
      'ctrl+r',
      'ctrl+w',
      'ctrl+z',
    ]);
  });

  it.each([
    ['ctrl+b', 0x02],
    ['ctrl+j', 0x0a],
    ['ctrl+p', 0x10],
    ['ctrl+r', 0x12],
    ['ctrl+w', 0x17],
    ['ctrl+z', 0x1a],
  ])('turns %s into the byte a terminal expects', (id, code) => {
    // The numbers rather than the rule that made them: a test that computed the
    // same expression as the code would agree with any expression at all.
    const chord = chordById(id);

    expect(chord?.bytes).toHaveLength(1);
    expect(chord?.bytes.charCodeAt(0)).toBe(code);
  });

  it('says what each one costs the person, so the price is written down', () => {
    for (const chord of TERMINAL_CHORDS) {
      expect(chord.means.length).toBeGreaterThan(0);
      expect(chord.instead.length).toBeGreaterThan(0);
    }
  });
});

describe('reading a key press', () => {
  it('finds the chord by the physical key, whatever letter is printed on it', () => {
    // `code` and not `key`: with a Cyrillic layout this press carries `о`, and
    // the acceptance list has a line about exactly that.
    expect(chordFor(press('KeyJ'))?.id).toBe('ctrl+j');
  });

  it('lets every other press through', () => {
    expect(chordFor(press('KeyA'))).toBeNull();
  });

  it.each([
    ['no control key at all', { ctrlKey: false }],
    ['the palette, which is control and shift', { shiftKey: true }],
    ['an alt binding of somebody else', { altKey: true }],
    ['a chord held with the windows key', { metaKey: true }],
  ])('is not %s', (_what, held) => {
    expect(chordFor(press('KeyP', held))).toBeNull();
  });
});

describe('reading what the editor named', () => {
  it('finds the chord the keybinding passed', () => {
    expect(chordById('ctrl+r')?.code).toBe('KeyR');
  });

  it.each([
    ['a chord we never asked for', 'ctrl+shift+k'],
    ['a number', 7],
    ['nothing at all', undefined],
  ])('refuses %s, because a command can be called by anyone', (_what, id) => {
    expect(chordById(id)).toBeNull();
  });
});

describe('the two presses that are not chords', () => {
  it('reads Ctrl+C as a copy, which the page then does only if anything is selected', () => {
    // With a selection it copies, without one it interrupts -- the owner's
    // decision of 2026-08-18. This half only says which press it is.
    expect(isCopyPress(press('KeyC'))).toBe(true);
  });

  it.each([
    ['the palette copy of the editor', { shiftKey: true }],
    ['an alt chord', { altKey: true }],
    ['a bare letter', { ctrlKey: false }],
  ])('does not read %s as a copy', (_what, held) => {
    expect(isCopyPress(press('KeyC', held))).toBe(false);
  });

  it('is not a copy on another letter', () => {
    expect(isCopyPress(press('KeyV'))).toBe(false);
  });

  it('reads Shift+Insert as a paste, which is the older of the two ways', () => {
    expect(isPastePress(press('Insert', { ctrlKey: false, shiftKey: true }))).toBe(true);
  });

  it.each([
    ['Insert on its own', { ctrlKey: false, shiftKey: false }],
    ['Ctrl+Shift+Insert', { ctrlKey: true, shiftKey: true }],
    ['Alt+Shift+Insert', { ctrlKey: false, shiftKey: true, altKey: true }],
  ])('does not read %s as a paste', (_what, held) => {
    expect(isPastePress(press('Insert', held))).toBe(false);
  });

  it('is not a paste on another key', () => {
    expect(isPastePress(press('KeyV', { ctrlKey: false, shiftKey: true }))).toBe(false);
  });
});
