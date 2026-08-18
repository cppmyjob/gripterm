// Types only: nothing here calls the editor. The clipboard arrives as a port
// and the context key as a function, because both are the editor's and this
// class is the rule about when to use them.
import type * as vscode from 'vscode';
import { TERMINAL_CHORDS, chordById } from '@gripterm/webview';
import type { Logger } from '@gripterm/core';
import type { TerminalChord, ViewMessage } from '@gripterm/webview';
import type { TerminalStage } from './terminal-stage';
import type { WorkbenchView } from './workbench-view';

/**
 * The keyboard, between a page and a pty: who has it, and what a chord means.
 *
 * **Why the extension is in this at all.** Every key of the acceptance list
 * reaches the page by itself (M3.1, both editors), so nothing here is about
 * delivery. Two things cannot be done inside a webview, and both are here:
 *
 *   * **Taking a chord away from the editor.** `Ctrl+J` hid the panel while the
 *     same press reached the page, and `Ctrl+R` reloaded the window under it.
 *     Only a keybinding of ours stops the editor acting, and a keybinding
 *     arrives as a command -- so the bytes for those six chords come from here
 *     rather than from xterm, and the page is told to keep out of them.
 *   * **The clipboard.** A webview can neither read nor write it, so copy and
 *     paste both cross the channel: the page says what is selected or that it
 *     wants to paste, and this answers.
 *
 * **The context key is raised by the page and lowered by both.** The page knows
 * where the keyboard is -- the details half is in the same document, and
 * `focusedView` cannot tell the halves apart (O6). But a page that goes away
 * says nothing on its way out, so the panel becoming invisible lowers the key
 * here; a webview destroyed with the key still up would leave every one of
 * those chords taken for the whole window.
 *
 * **And the command checks again.** A `when` clause is a permission, not a
 * fact: any command is callable from the palette, from a script, from another
 * extension. So `press` asks the same question the context key answers, and
 * refuses out loud -- which is also the only way "a key does not reach the pty
 * from the details half" can be tested at all.
 */

/**
 * The context key every one of those keybindings hangs on.
 *
 * Named here and nowhere else, and NOT `focusedView`: that key is true for the
 * whole panel, so the arrow keys and `Esc` would be taken from a person writing
 * in the details half (O6). An integration test reads the manifest and checks
 * that this is the `when` of every chord in the table.
 */
export const TERMINAL_FOCUSED_KEY = 'gripterm.terminalFocused';

export interface Clipboard {
  readonly read: () => Promise<string>;
  readonly write: (text: string) => Promise<void>;
}

export interface TerminalKeyboardOptions {
  readonly view: WorkbenchView;
  readonly stage: TerminalStage;
  readonly clipboard: Clipboard;
  readonly logger: Logger;
  /** Raises and lowers the context key the keybindings hang on. */
  readonly announce: (focused: boolean) => void;
}

export class TerminalKeyboard implements vscode.Disposable {
  private readonly _options: TerminalKeyboardOptions;
  private readonly _subscriptions: vscode.Disposable[] = [];
  private readonly _refusals: string[] = [];
  private _focused = false;

  constructor(options: TerminalKeyboardOptions) {
    this._options = options;
    this._subscriptions.push(
      options.view.onMessage((message) => { this._heard(message); }),
      options.view.onVisibility((visible) => {
        if (!visible) {
          // A page behind a hidden panel has no keyboard, and a page that was
          // destroyed cannot say so itself.
          this._took(false);
        }
      })
    );
  }

  /**
   * The chords this window really has, from the table it really reads.
   *
   * Handed out rather than imported by the suite: the manifest is checked
   * against THIS list, and a test that imported the table would be comparing the
   * manifest with a second compiled copy of it -- which is the drift it is
   * supposed to catch.
   */
  public get chords(): readonly TerminalChord[] {
    return TERMINAL_CHORDS;
  }

  /** Whether the terminal element of the page has the keyboard right now. */
  public get focused(): boolean {
    return this._focused;
  }

  /** Everything this refused to do, in its own words. Kept for the log and the suite. */
  public get refusals(): readonly string[] {
    return this._refusals;
  }

  /**
   * A chord the editor handed back, on its way to the process.
   *
   * The argument comes from the keybinding's `args` in the manifest, so it is
   * whatever somebody wrote there -- checked here rather than trusted.
   */
  public press(chordId: unknown): void {
    const chord = chordById(chordId);
    if (chord === null) {
      this._refuse(`a chord this window does not know: ${JSON.stringify(chordId)}`);
      return;
    }
    if (!this._focused) {
      this._refuse(`${chord.id} was pressed while the terminal did not have the keyboard`);
      return;
    }
    const terminalId = this._options.stage.activeTerminal;
    const bridge = terminalId === null ? undefined : this._options.stage.bridgeFor(terminalId);
    if (bridge === undefined) {
      this._refuse(`${chord.id} was pressed with no terminal of ours on the screen`);
      return;
    }
    bridge.type(chord.bytes);
  }

  public dispose(): void {
    for (const subscription of this._subscriptions) {
      subscription.dispose();
    }
    this._subscriptions.length = 0;
    // The key belongs to the window rather than to this object, so it does not
    // outlive it: a context key left up is every one of those chords taken from
    // the person for as long as the window is open.
    this._took(false);
  }

  private _heard(message: ViewMessage): void {
    switch (message.kind) {
      case 'focused':
        this._took(message.focused);
        return;
      case 'copy':
        void this._copy(message.text);
        return;
      case 'wants-paste':
        void this._paste();
        return;
      default:
        return;
    }
  }

  private _took(focused: boolean): void {
    if (focused === this._focused) {
      return;
    }
    this._focused = focused;
    this._options.announce(focused);
  }

  private async _copy(text: string): Promise<void> {
    try {
      await this._options.clipboard.write(text);
    } catch (cause: unknown) {
      this._refuse(`the selection could not be put on the clipboard: ${String(cause)}`);
    }
  }

  private async _paste(): Promise<void> {
    let text = '';
    try {
      text = await this._options.clipboard.read();
    } catch (cause: unknown) {
      this._refuse(`the clipboard could not be read: ${String(cause)}`);
      return;
    }
    if (text.length === 0) {
      return;
    }
    // Back to the page rather than into the pty: `term.paste` is what wraps it
    // in the bracketed-paste markers the CLI asked for.
    this._options.view.post({ kind: 'paste', text });
  }

  private _refuse(what: string): void {
    this._refusals.push(what);
    this._options.logger.warn('a key press was not passed on to a terminal', { what });
  }
}
