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

  public write(text: string): void {
    this._terminal.write(text);
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
