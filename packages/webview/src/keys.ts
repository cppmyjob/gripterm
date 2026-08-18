/**
 * The chords this terminal takes away from the editor, and what they mean.
 *
 * **Why a table and not six entries in a manifest.** Both sides of the channel
 * need the same list and would otherwise keep their own: the manifest
 * contributes them to the editor, and the page has to know which presses NOT to
 * handle itself. Two lists able to drift apart are the defect this build keeps
 * meeting -- so there is one, and an integration test reads the manifest and
 * compares it with this.
 *
 * **Why they are taken at all.** Measured 2026-08-17 (M3.1, both editors): every
 * key of the acceptance list reaches the page by itself, so nothing here is
 * about delivery. It is about the editor acting TOO -- `Ctrl+J` was seen hiding
 * the panel while the same press reached the page, and `Ctrl+R` never got there
 * at all because the window reloaded under it. The same measurement showed that
 * a chord can be taken back with a keybinding of ours, and that is all this is.
 *
 * **Whose list this is.** The owner's decision of 2026-08-18: the whole M3.1
 * list, so that a terminal of ours behaves like a terminal, at the price of
 * those six editor commands while the focus is really inside it. Cursor's own
 * chords (`Ctrl+K`, `Ctrl+L`, `Ctrl+I`, `Tab`, `Ctrl+Shift+L`) are NOT here: the
 * same protocol measured all of them reaching the page already, with the editor
 * doing nothing on top of it.
 */

/** What a key press looks like to this rule. A `KeyboardEvent` is one of these. */
export interface KeyPress {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

export interface TerminalChord {
  /** What the manifest binds, and what the command is handed as its argument. */
  readonly id: string;
  /**
   * The physical key, by `KeyboardEvent.code`.
   *
   * The position and not the character: with a Cyrillic layout `event.key` for
   * this key is a Cyrillic letter, and "кириллица" is a line of the acceptance
   * list. The editor dispatches its own keybindings against the same physical
   * position.
   */
  readonly code: string;
  /** The bytes a terminal expects for it. */
  readonly bytes: string;
  /** What the agent does with it -- the reason for taking it. */
  readonly means: string;
  /** What the editor does with it -- the price of taking it. */
  readonly instead: string;
}

/** What a letter keeps when it becomes a control byte: the low five bits. */
const CONTROL_MASK = 0x1f;

/**
 * `Ctrl+<letter>` as bytes, by the rule rather than by six escapes.
 *
 * The letter's code with the top three bits cleared: `B` is 0x42, `Ctrl+B` is
 * 0x02. Written this way because a control character pasted into a source file
 * is invisible in every diff it ever appears in -- and this table is exactly
 * where somebody would later mistake one for another.
 */
function controlByte(letter: string): string {
  return String.fromCharCode(letter.charCodeAt(0) & CONTROL_MASK);
}

export const TERMINAL_CHORDS: readonly TerminalChord[] = [
  {
    id: 'ctrl+b',
    code: 'KeyB',
    bytes: controlByte('B'),
    means: 'one character back in the prompt',
    instead: 'View: Toggle Primary Side Bar',
  },
  {
    id: 'ctrl+j',
    code: 'KeyJ',
    bytes: controlByte('J'),
    means: 'a newline inside the prompt, which is how a multi-line question is asked',
    instead: 'View: Toggle Panel',
  },
  {
    id: 'ctrl+p',
    code: 'KeyP',
    bytes: controlByte('P'),
    means: 'the previous line of history',
    instead: 'Go to File (Quick Open)',
  },
  {
    id: 'ctrl+r',
    code: 'KeyR',
    bytes: controlByte('R'),
    means: 'search backwards through history',
    instead: 'Developer: Reload Window -- which is why this one never reached a page at all',
  },
  {
    id: 'ctrl+w',
    code: 'KeyW',
    bytes: controlByte('W'),
    means: 'delete the word before the cursor',
    instead: 'View: Close Editor',
  },
  {
    id: 'ctrl+z',
    code: 'KeyZ',
    bytes: controlByte('Z'),
    means: 'suspend, which an agent answers as it likes',
    instead: 'Undo',
  },
];

/**
 * The chord this press is, or `null` for every other press.
 *
 * Exact about the modifiers, deliberately: `Ctrl+Shift+P` is the command
 * palette and `Ctrl+Alt+J` is somebody else's binding, and a rule that matched
 * on the control key alone would take both away from the person.
 */
export function chordFor(press: KeyPress): TerminalChord | null {
  if (!press.ctrlKey || press.altKey || press.shiftKey || press.metaKey) {
    return null;
  }
  return TERMINAL_CHORDS.find((chord) => chord.code === press.code) ?? null;
}

/**
 * Whether this press means "copy what is selected".
 *
 * `Ctrl+C` with a selection copies and WITHOUT one interrupts -- the owner's
 * decision of 2026-08-18 and the editor's own rule for its terminal. The
 * selection is not this rule's business: this says which press it is, and the
 * page asks the screen whether there is anything to copy.
 */
export function isCopyPress(press: KeyPress): boolean {
  return press.ctrlKey && !press.altKey && !press.shiftKey && !press.metaKey && press.code === 'KeyC';
}

/**
 * Whether this press means "paste".
 *
 * `Shift+Insert`, which is the second way and the older one. `Ctrl+V` is not
 * here: it arrives as the document's own paste event, which xterm already
 * answers through `term.paste` -- taking it as a key press too would paste
 * twice.
 */
export function isPastePress(press: KeyPress): boolean {
  return press.shiftKey && !press.ctrlKey && !press.altKey && !press.metaKey && press.code === 'Insert';
}

/** The chord the editor named when it ran our command, or `null` if it named none of ours. */
export function chordById(id: unknown): TerminalChord | null {
  return TERMINAL_CHORDS.find((chord) => chord.id === id) ?? null;
}
