import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { ITheme } from '@xterm/xterm';

/**
 * The terminal screen: xterm, the theme it is given, and the one guard that
 * keeps a hidden panel from resizing it to nothing.
 *
 * The unicode11 addon is not optional and is not a preference. Measured in the
 * M3.2 stand (stage B, answer 4): with Unicode 6 widths, `✅` and `🙂` are one
 * cell wide instead of two, and Claude Code prints both on ordinary turns -- so
 * every frame it draws after one of them is off by a column, and the TUI looks
 * broken in a way that has nothing to do with the CLI.
 */

const FALLBACK_BACKGROUND = '#1e1e1e';
const FALLBACK_FOREGROUND = '#cccccc';

export interface ScreenOptions {
  readonly scrollback: number;
  readonly fontFamily: string;
  readonly fontSize: number;
}

export class Screen {
  private readonly _terminal: Terminal;
  private readonly _fit: FitAddon;
  private _background = FALLBACK_BACKGROUND;
  private _written = 0;
  /** Which screenful the count belongs to. Bumped by `reset` -- see `write`. */
  private _screenful = 0;
  /** How long this screen pretends to need per message. Probe only -- see `linger`. */
  private _lingerMs = 0;

  constructor(host: HTMLElement, options: ScreenOptions) {
    this._terminal = new Terminal({
      // Required by the unicode addon below: the version table is proposed API
      // in 6.0.0, and without this flag `unicode.activeVersion` throws.
      allowProposedApi: true,
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      scrollback: options.scrollback,
      // Off, and this is a decision: a terminal that blinks the cursor repaints
      // twice a second forever, in a panel a person keeps open all day.
      cursorBlink: false,
      theme: this._readTheme(),
    });
    this._fit = new FitAddon();
    this._terminal.loadAddon(this._fit);
    this._terminal.loadAddon(new Unicode11Addon());
    this._terminal.unicode.activeVersion = '11';
    this._terminal.open(host);
  }

  public get cols(): number {
    return this._terminal.cols;
  }

  public get rows(): number {
    return this._terminal.rows;
  }

  public get background(): string {
    return this._background;
  }

  public get fontFamily(): string {
    return this._terminal.options.fontFamily ?? '';
  }

  public get fontSize(): number {
    return this._terminal.options.fontSize ?? 0;
  }

  public get scrollback(): number {
    return this._terminal.options.scrollback ?? 0;
  }

  /** Which width table is in force -- '11' when the addon took, '6' when not. */
  public get unicodeVersion(): string {
    return this._terminal.unicode.activeVersion;
  }

  /**
   * Code units this screen has PARSED since it was last emptied.
   *
   * Counted from xterm's callback rather than at the call, and that is the same
   * distinction the receipts are made of: text handed to xterm waits in a queue
   * it works through on its own timers, so a count taken at the call says
   * "written" of bytes nothing has looked at yet.
   *
   * It was the count at the call until 2026-08-18, and the cost was exact: with
   * it, a page acknowledging on ARRIVAL and a page acknowledging on PARSING
   * report the same numbers, so nothing in the suite could tell them apart --
   * and the mutation that swapped one for the other survived the whole battery
   * (M19 of M3.7). A receipt that means "the message reached me" measures the
   * postMessage queue; the queue back-pressure exists for is this one.
   */
  public get written(): number {
    return this._written;
  }

  /**
   * Writes towards the screen, and says when it really landed.
   *
   * `whenWritten` fires from xterm's own callback, which runs when the text has
   * been PARSED rather than when the message arrived -- and that difference is
   * the whole of back-pressure. It is the only honest receipt there is: xterm
   * schedules its parsing through `setTimeout`, so a consumer that acknowledged
   * on arrival would be acknowledging a queue it has not touched (M3.2 stage B,
   * §6).
   */
  public write(text: string, whenWritten?: () => void): void {
    const screenful = this._screenful;
    this._terminal.write(text, () => {
      if (this._lingerMs === 0) {
        this._took(screenful, text.length, whenWritten);
        return;
      }
      // The probe: a screen slower than the stream, which is the only state in
      // which "the receipt follows the parsing" can be told from "the receipt
      // follows the arrival" -- see `linger`.
      window.setTimeout(() => { this._took(screenful, text.length, whenWritten); }, this._lingerMs);
    });
  }

  /**
   * Makes this screen take its time over each message. `0` turns it off.
   *
   * The probe that keeps "a receipt means the screen has taken it in" from
   * being unfalsifiable. Measured 2026-08-18: xterm parses this machine's flood
   * -- 1.6 million code units of plain lines -- faster than the pty produces
   * it, so a page acknowledging on ARRIVAL and a page acknowledging on PARSING
   * report the same numbers, and the mutation swapping one for the other
   * survived two attempts to catch it. Under this probe they differ by
   * everything the screen has not got to yet.
   *
   * It slows the count and the receipt TOGETHER, because both are the same
   * event -- the message landed. A probe that delayed only the receipt would be
   * testing the delay rather than the rule.
   */
  public linger(ms: number): void {
    this._lingerMs = ms;
  }

  /**
   * Empties the screen for a terminal that is not the one it was showing.
   *
   * `reset` rather than `clear`: `clear` keeps the current line and every mode
   * the previous agent left switched on -- bracketed paste, the alternate
   * buffer, a scroll region -- and those would then be applied to somebody
   * else's output.
   */
  public reset(): void {
    this._terminal.reset();
    this._screenful += 1;
    this._written = 0;
  }

  /** Everything the person types, on its way out. */
  public onInput(listener: (data: string) => void): void {
    this._terminal.onData(listener);
  }

  /** The size the screen settled at, which is the size the pty must be told. */
  public onResized(listener: (cols: number, rows: number) => void): void {
    this._terminal.onResize(({ cols, rows }) => { listener(cols, rows); });
  }

  /**
   * Types into the screen exactly as a keystroke does.
   *
   * xterm's own `input`, so the text goes through the same path a key press
   * takes and reaches the same `onData` -- which is what makes the suite's
   * "input is not lost under a flood" a test of the channel rather than of a
   * second implementation of it (§I.1).
   */
  public type(text: string): void {
    this._terminal.input(text, true);
  }

  /**
   * Takes the colours from the editor again, and the font from the host.
   *
   * The colours are read from CSS variables the editor keeps up to date by
   * itself; the font is not a variable at all -- `terminal.integrated.fontFamily`
   * is a setting, and a webview cannot read settings -- so it arrives in the
   * message that ordered this.
   */
  public restyle(fontFamily: string, fontSize: number): void {
    this._terminal.options.theme = this._readTheme();
    this._terminal.options.fontFamily = fontFamily;
    this._terminal.options.fontSize = fontSize;
  }

  /**
   * Sizes the screen to its box, or refuses.
   *
   * `proposeDimensions()` answers NaN for a box with no geometry (xterm.js#3029)
   * -- a hidden panel, a half of zero width, a page that has not been laid out
   * yet. `fit()` would pass that on to `resize()`, and the resize would reach
   * the pty in M3.7 as a terminal of no columns. So the numbers are read first
   * and refused here.
   */
  public fit(): boolean {
    const proposed = this._fit.proposeDimensions();
    if (proposed === undefined) {
      return false;
    }
    const { cols, rows } = proposed;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
      return false;
    }
    if (cols !== this._terminal.cols || rows !== this._terminal.rows) {
      this._terminal.resize(cols, rows);
    }
    return true;
  }

  public dispose(): void {
    this._terminal.dispose();
  }

  /** One message, taken in: counted if it belongs to this screenful, then acknowledged. */
  private _took(screenful: number, chars: number, whenWritten: (() => void) | undefined): void {
    if (screenful === this._screenful) {
      // Text handed over before the screen was emptied for another terminal
      // does not count towards this one: xterm keeps its queue across a
      // `reset`, so those callbacks arrive after it.
      this._written += chars;
    }
    whenWritten?.();
  }

  /**
   * The editor's own colours, as the webview is given them.
   *
   * Every one is a CSS variable the editor writes into the document, so a theme
   * we have never seen works without a table of our own. The fallbacks are the
   * chain the editor itself falls back along: a theme need not define terminal
   * colours, and most define the panel's.
   */
  private _readTheme(): ITheme {
    const style = getComputedStyle(document.body);
    const pick = (names: readonly string[], fallback: string): string => {
      for (const name of names) {
        const found = style.getPropertyValue(name).trim();
        if (found.length > 0) {
          return found;
        }
      }
      return fallback;
    };

    this._background = pick(
      ['--vscode-terminal-background', '--vscode-panel-background', '--vscode-editor-background'],
      FALLBACK_BACKGROUND
    );
    return {
      background: this._background,
      foreground: pick(['--vscode-terminal-foreground', '--vscode-foreground'], FALLBACK_FOREGROUND),
      cursor: pick(['--vscode-terminalCursor-foreground', '--vscode-foreground'], FALLBACK_FOREGROUND),
      cursorAccent: pick(['--vscode-terminalCursor-background'], this._background),
      selectionBackground: pick(
        ['--vscode-terminal-selectionBackground', '--vscode-editor-selectionBackground'],
        '#264f78'
      ),
      black: pick(['--vscode-terminal-ansiBlack'], '#000000'),
      red: pick(['--vscode-terminal-ansiRed'], '#cd3131'),
      green: pick(['--vscode-terminal-ansiGreen'], '#0dbc79'),
      yellow: pick(['--vscode-terminal-ansiYellow'], '#e5e510'),
      blue: pick(['--vscode-terminal-ansiBlue'], '#2472c8'),
      magenta: pick(['--vscode-terminal-ansiMagenta'], '#bc3fbc'),
      cyan: pick(['--vscode-terminal-ansiCyan'], '#11a8cd'),
      white: pick(['--vscode-terminal-ansiWhite'], '#e5e5e5'),
      brightBlack: pick(['--vscode-terminal-ansiBrightBlack'], '#666666'),
      brightRed: pick(['--vscode-terminal-ansiBrightRed'], '#f14c4c'),
      brightGreen: pick(['--vscode-terminal-ansiBrightGreen'], '#23d18b'),
      brightYellow: pick(['--vscode-terminal-ansiBrightYellow'], '#f5f543'),
      brightBlue: pick(['--vscode-terminal-ansiBrightBlue'], '#3b8eea'),
      brightMagenta: pick(['--vscode-terminal-ansiBrightMagenta'], '#d670d6'),
      brightCyan: pick(['--vscode-terminal-ansiBrightCyan'], '#29b8db'),
      brightWhite: pick(['--vscode-terminal-ansiBrightWhite'], '#e5e5e5'),
    };
  }
}
