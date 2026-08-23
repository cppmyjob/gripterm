import * as vscode from 'vscode';
import { presentTerminal, stateWords } from '@gripterm/core';
import type { Disposable, Logger, RegistryChange, SessionRegistry, TerminalId } from '@gripterm/core';

/** The scheme the editor gives a terminal that lives in the editor area. */
const TERMINAL_SCHEME = 'vscode-terminal';

export interface TerminalTabDecorationsOptions {
  readonly registry: SessionRegistry;
  readonly logger: Logger;
}

/**
 * The state of an agent, on the tab of its terminal.
 *
 * **The customer's third complaint, 2026-08-21:** "Иконка статуса не
 * отображается в табе терминала, но отображается в treeview." They are looking
 * at the tabs, and the tabs said nothing.
 *
 * **What the editor does not offer, and it was measured before this was
 * written.** A terminal's icon is fixed when it is created -- there is no API
 * that changes it afterwards. Its NAME can be changed, but only through a
 * command that renames the ACTIVE terminal, which is the one terminal the
 * person is already looking at; a status carried in the name would therefore be
 * right for the tab nobody needs it on and stale on every other.
 *
 * **What it does offer.** A tab in the editor area is drawn from a uri, and the
 * workbench asks every `FileDecorationProvider` about it. Measured 2026-08-21
 * in a real host: our terminal's tab is asked about as
 * `vscode-terminal:/<workspace>/<n>`, and both settings that draw the answer --
 * `workbench.editor.decorations.badges` and `.colors` -- are `true` by default
 * in VS Code and in Cursor. A badge of one or two characters and a colour can
 * reach a tab, and nothing else can.
 *
 * **`<n>` is COUNTED, not guessed, and that is the whole design.** No API hands
 * that number out. Measured in a real host on 2026-08-21, over a mixed run --
 * a stranger's panel terminal, ours, a stranger's editor terminal, ours again:
 *
 *     opened #1 probe-panel        (no tab, never asked about)
 *     opened #2 probe-ours-1   ->  vscode-terminal:/ext-dev/2
 *     opened #3 probe-foreign  ->  vscode-terminal:/ext-dev/3
 *     opened #4 probe-ours-2   ->  vscode-terminal:/ext-dev/4
 *
 * The number is the ORDER the terminal was opened in, counting every terminal
 * in the window -- including the ones that never get a tab. `onDidOpenTerminal`
 * is the same order, so counting it gives each terminal its number, and the
 * gateway says which of those terminals are ours.
 *
 * **The one assumption left, named with its price.** The count starts at
 * `window.terminals.length`, the terminals already open when this window
 * started us. A terminal that was opened AND CLOSED before that -- some other
 * extension, in the seconds before `onStartupFinished` -- would have taken a
 * number nobody counted, and every number after it would be one too low. What
 * that costs is a badge on somebody else's tab, so a number that names no
 * terminal of ours is left alone rather than assumed: nothing is drawn on a tab
 * this build cannot account for. REMOVED WHEN: the API names a terminal in a
 * way that reaches a decoration.
 */
export class TerminalTabDecorations implements vscode.FileDecorationProvider, Disposable {
  /**
   * Declared without a value and given one in the constructor, so that the
   * public member can stand above the private fields the linter asks it to --
   * a field initialised from `this._changed` would have to be declared after
   * it, which is the one order the rule refuses.
   */
  public readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]>;

  private readonly _changed = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  private readonly _options: TerminalTabDecorationsOptions;
  private readonly _subscription: Disposable;
  private readonly _provider: vscode.Disposable;
  private readonly _opening: vscode.Disposable;
  /** The number every terminal object was given, so that a late claim can still find it. */
  private readonly _numbers = new WeakMap<vscode.Terminal, number>();
  /** A terminal claimed as ours before its opening was counted. */
  private readonly _claimed = new WeakMap<vscode.Terminal, TerminalId>();
  /** Number -> the terminal of ours it belongs to. */
  private readonly _ours = new Map<number, TerminalId>();
  /** Terminal id -> the uri its tab turned out to have, once the tab has been drawn. */
  private readonly _uris = new Map<string, vscode.Uri>();
  /** How many terminals this window has opened, counting the ones it started with. */
  private _opened: number;

  constructor(options: TerminalTabDecorationsOptions) {
    this._options = options;
    this.onDidChangeFileDecorations = this._changed.event;
    // Everything already open took a number before we were here to count it.
    this._opened = vscode.window.terminals.length;
    this._opening = vscode.window.onDidOpenTerminal((terminal) => {
      this._opened += 1;
      this._numbers.set(terminal, this._opened);
      const claimed = this._claimed.get(terminal);
      if (claimed !== undefined) {
        this._file(this._opened, claimed);
      }
    });
    this._provider = vscode.window.registerFileDecorationProvider(this);
    this._subscription = options.registry.subscribe((change: RegistryChange) => {
      this._onChange(change);
    });
  }

  public dispose(): void {
    this._opening.dispose();
    this._provider.dispose();
    this._subscription.dispose();
    this._changed.dispose();
    this._ours.clear();
    this._uris.clear();
  }

  /**
   * This terminal is one of ours.
   *
   * Told by the gateway, which is the only thing that knows: no event says
   * whose a terminal is. The opening may have been counted already or may be
   * about to be -- the API promises no order between `createTerminal` returning
   * and `onDidOpenTerminal` firing -- so both ways round are handled rather
   * than one of them assumed.
   */
  public expect(terminalId: TerminalId, terminal: vscode.Terminal): void {
    const number = this._numbers.get(terminal);
    if (number === undefined) {
      this._claimed.set(terminal, terminalId);
      return;
    }
    this._file(number, terminalId);
  }

  /**
   * The tab this terminal was paired with, or `undefined` while it has none.
   *
   * Read by the live suite, which cannot ask the workbench which uri it drew.
   * It is also the honest answer to "did the pairing work at all": a terminal
   * that never got one is a tab this build is not drawing anything on.
   */
  public uriFor(terminalId: TerminalId): vscode.Uri | undefined {
    return this._uris.get(terminalId.value);
  }

  /** That terminal is gone, and its tab with it. */
  public forget(terminalId: TerminalId): void {
    this._uris.delete(terminalId.value);
    for (const [number, mine] of this._ours) {
      if (mine.equals(terminalId)) {
        this._ours.delete(number);
      }
    }
  }

  public provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== TERMINAL_SCHEME) {
      return undefined;
    }
    const terminalId = this._ours.get(numberIn(uri));
    if (terminalId === undefined) {
      // Somebody else's terminal, or one this build cannot account for. Both
      // are left alone: a badge here would be a claim about a tab that is not
      // ours to make one about.
      return undefined;
    }
    const entry = this._options.registry.get(terminalId);
    if (entry === undefined) {
      return undefined;
    }
    /*
     * The LAST uri wins, and that is the whole of the owner's report of
     * 2026-08-23: "статус 1го таба почему-то остался синим", blue with the
     * `launching` badge, beside a row for the same record that said `idle`.
     *
     * A record gets a second tab whenever its terminal is started again -- a
     * resume, a start over, a close and a new one -- and what stood here kept
     * the FIRST one for ever. Every change after that was announced against a
     * uri whose tab had gone, so the new tab kept whatever it was drawn with
     * the instant it appeared, which is `launching`: what a terminal that has
     * just started is. Measured 2026-08-23, and this is the line it printed:
     * "waited 20000 ms for the pairing to move to the new tab (it is still
     * vscode-terminal:/ext-dev/1)".
     *
     * Safe because a record has one terminal at a time. The tab of the one
     * before it is gone, and `_file` has already dropped the number it was
     * filed under, so nothing can pair a record back to a tab that closed.
     */
    const paired = this._uris.get(terminalId.value);
    if (paired?.toString() !== uri.toString()) {
      this._uris.set(terminalId.value, uri);
      this._options.logger.info('a terminal tab was paired with its record', {
        terminalId: terminalId.value,
        uri: uri.toString(),
        ...(paired === undefined ? {} : { instead: paired.toString() }),
      });
    }

    const shown = presentTerminal(entry, { ours: true });
    // The colour is spread in rather than set to `undefined`: under
    // `exactOptionalPropertyTypes` those are different things, and the second
    // one does not compile -- the compiler catching the same confusion the
    // gateway's `shellPath` avoids the same way.
    return {
      badge: shown.badge,
      tooltip: `${shown.label} — ${stateWords(shown.state)}`,
      ...(shown.colorId === null ? {} : { color: new vscode.ThemeColor(shown.colorId) }),
    };
  }

  /**
   * Files a number under a record, and lets go of every number that record was
   * filed under before it.
   *
   * One record has one terminal at a time, so an older number names a terminal
   * that has closed. Left in place it would be a uri that still answers with
   * our record -- and the pairing, which now follows the tab it was last asked
   * about, could be pulled back to a tab that is not there.
   */
  private _file(number: number, terminalId: TerminalId): void {
    for (const [was, mine] of this._ours) {
      /*
       * By value, and not by `equals`. Everything that keys on a terminal in
       * this build keys on `.value` -- the gateway's handles do -- and a
       * comparison that needs a METHOD on the id makes this event handler
       * throw where they do not. Measured 2026-08-23: it threw inside
       * `onDidOpenTerminal`, the workbench swallowed it, and the terminal was
       * simply never filed. A silent handler is a bad place to need a method.
       */
      if (mine.value === terminalId.value && was !== number) {
        this._ours.delete(was);
      }
    }
    this._ours.set(number, terminalId);
  }

  private _onChange(change: RegistryChange): void {
    if (change.kind === 'removed') {
      this.forget(change.terminalId);
      return;
    }
    if (change.kind !== 'entry') {
      return;
    }
    const uri = this._uris.get(change.entry.terminalId.value);
    if (uri !== undefined) {
      // Only the tab that changed. The workbench asks again for exactly the
      // uris named here, so a blanket refresh would ask about every terminal in
      // the window on every hook that arrives.
      this._changed.fire(uri);
    }
  }
}

/**
 * The number at the end of `vscode-terminal:/<workspace>/<n>`, or `NaN`.
 *
 * `NaN` is a number no terminal of ours is ever filed under, so a uri in a
 * shape this build has not seen falls through the lookup and is left alone --
 * which is the same answer as "somebody else's tab", and the right one.
 */
function numberIn(uri: vscode.Uri): number {
  return Number(uri.path.split('/').at(-1));
}
