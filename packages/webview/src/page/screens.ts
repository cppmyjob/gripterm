import { Screen } from './screen';
import type { ScreenOptions } from './screen';

/**
 * Every terminal's screen, stacked one on top of another in the same box.
 *
 * **One live xterm per terminal, and that is the whole of M3.9's cost and its
 * whole point.** Until this step the panel had one screen and switching meant
 * emptying it and replaying a tail: the person's scrollback, selection and
 * cursor went every time, and a TUI had to be redrawn by the agent itself. A
 * screen per terminal keeps all of it, and keeps taking output while it is out
 * of sight -- so switching is a change of what is visible and nothing else.
 *
 * **Hidden is `visibility`, never `display: none`.** A box with no display has
 * no geometry, `FitAddon.proposeDimensions()` answers `NaN` for it, and `fit()`
 * passes that on to a `resize` that reaches a real pty (xterm.js#3029). Hidden
 * this way the box keeps its size, so every screen can be fitted while nobody is
 * looking at it -- which is what makes a tab switch free of a resize, and what
 * the acceptance line of this step is about.
 *
 * **The idle screen is not a placeholder.** It is a real terminal with the
 * editor's theme and the unicode table on it, shown when the panel is holding
 * nothing, and it exists so that the page can answer for its own font, colours
 * and width tables before any agent is started -- which is what M3.6's report
 * promises and what a page with no screens at all could not say a word about.
 */
export class Screens {
  private readonly _host: HTMLElement;
  private readonly _options: ScreenOptions;
  private readonly _boxes = new Map<string, HTMLElement>();
  private readonly _screens = new Map<string, Screen>();
  /** The screen shown when no terminal is. Always there, never in `_screens`. */
  private readonly _idle: Screen;
  private readonly _idleBox: HTMLElement;
  private _showing: string | null = null;
  /** Passed on to every screen made later, so a probe set once keeps applying. */
  private _lingerMs = 0;

  constructor(host: HTMLElement, options: ScreenOptions) {
    this._host = host;
    this._options = options;
    this._idleBox = this._newBox();
    this._idle = new Screen(this._idleBox, options);
    this._idleBox.style.visibility = 'visible';
  }

  /** The terminal on screen, or `null` when the idle screen is. */
  public get showing(): string | null {
    return this._showing;
  }

  /** The screen a person is looking at -- a terminal's, or the idle one. */
  public get visible(): Screen {
    const shown = this._showing === null ? undefined : this._screens.get(this._showing);
    return shown ?? this._idle;
  }

  /** Every terminal that has a screen here, in the order they were taken. */
  public get ids(): readonly string[] {
    return [...this._screens.keys()];
  }

  /** The idle screen, for the page to write its "nothing here yet" on. */
  public get idle(): Screen {
    return this._idle;
  }

  public get(terminalId: string): Screen | undefined {
    return this._screens.get(terminalId);
  }

  /**
   * This terminal's screen, made if it has none.
   *
   * Says whether it is NEW, and the caller needs that rather than being able to
   * work it out: a screen wired up twice posts every keystroke to the pty twice,
   * and the two copies cannot be told apart from the other end.
   */
  public open(terminalId: string): { readonly screen: Screen, readonly fresh: boolean } {
    const existing = this._screens.get(terminalId);
    if (existing !== undefined) {
      return { screen: existing, fresh: false };
    }
    const box = this._newBox();
    const screen = new Screen(box, this._options);
    screen.linger(this._lingerMs);
    this._boxes.set(terminalId, box);
    this._screens.set(terminalId, screen);
    return { screen, fresh: true };
  }

  /**
   * Throws this terminal's screen away, for good.
   *
   * What the tab's cross comes to in the end. It has to be a real disposal:
   * a page kept alive behind a hidden panel (`retainContextWhenHidden`) never
   * reloads, so a screen merely hidden would hold its scrollback and its canvas
   * for as long as the window is open.
   */
  public close(terminalId: string): void {
    const screen = this._screens.get(terminalId);
    if (screen === undefined) {
      return;
    }
    screen.dispose();
    this._boxes.get(terminalId)?.remove();
    this._screens.delete(terminalId);
    this._boxes.delete(terminalId);
    if (this._showing === terminalId) {
      this.show(null);
    }
  }

  /**
   * Brings one terminal's screen to the front, or the idle screen when there is
   * no terminal to show.
   *
   * The keyboard follows, and only when it was already here: a switch made while
   * the person was typing in the terminal must leave them typing in the terminal,
   * and a switch made while they were writing a note in the other half must not
   * take their cursor away from it (O6).
   */
  public show(terminalId: string | null): void {
    // A terminal with no screen here shows the idle one rather than nothing: the
    // page would otherwise keep the previous agent's output on screen under a
    // strip that says another one is selected.
    const wanted = terminalId !== null && this._screens.has(terminalId) ? terminalId : null;
    if (wanted === this._showing) {
      return;
    }
    const hadKeyboard = this.visible.focused;
    this._showing = wanted;
    for (const [id, box] of this._boxes) {
      box.style.visibility = id === wanted ? 'visible' : 'hidden';
    }
    this._idleBox.style.visibility = wanted === null ? 'visible' : 'hidden';
    if (hadKeyboard) {
      this.visible.focus();
    }
  }

  /**
   * Sizes every screen, hidden ones included.
   *
   * The reason the boxes are hidden by `visibility`: a screen fitted only when
   * it is shown would be fitted at the moment a person switches to it, and the
   * agent on it would redraw its whole TUI in front of them. Fitted here, the
   * switch costs nothing -- which is the acceptance line of this step.
   */
  public fit(): void {
    this._idle.fit();
    for (const screen of this._screens.values()) {
      screen.fit();
    }
  }

  public restyle(fontFamily: string, fontSize: number): void {
    this._idle.restyle(fontFamily, fontSize);
    for (const screen of this._screens.values()) {
      screen.restyle(fontFamily, fontSize);
    }
  }

  /** The probe of M3.7, applied to every screen there is and every screen to come. */
  public linger(ms: number): void {
    this._lingerMs = ms;
    this._idle.linger(ms);
    for (const screen of this._screens.values()) {
      screen.linger(ms);
    }
  }

  private _newBox(): HTMLElement {
    const box = this._newElement();
    this._host.append(box);
    return box;
  }

  private _newElement(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'gripterm-screen';
    // Hidden until somebody shows it, and hidden by `visibility` so that it
    // still has a size to be fitted to (xterm.js#3029).
    box.style.visibility = 'hidden';
    return box;
  }
}
