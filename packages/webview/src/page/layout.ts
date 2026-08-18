import { resolveSplit } from '../split-rule';

/**
 * The two halves of the panel and the border between them.
 *
 * The left half is where the agent's terminal runs; the right half is where what
 * Gripterm knows about it goes (M3.11). Both existed before either was filled,
 * because a border can only be dragged between two things, and because a half
 * that appears late tends to appear at the cost of the one that was there first.
 *
 * The numbers below are decisions, and each is here rather than in the
 * stylesheet so that the rule they feed can be tested:
 *   * the divider is four pixels of layout, grabbable across eleven (the
 *     stylesheet widens the hit area without widening the divider);
 *   * neither half may be squeezed below its minimum -- a terminal of forty
 *     columns is not a terminal, and a details half narrower than its own
 *     headings is a scrollbar;
 *   * before anybody drags anything, the terminal takes seven tenths.
 */

const DIVIDER_PX = 4;
const MIN_TERMINAL_PX = 240;
const MIN_DETAILS_PX = 180;
const TERMINAL_SHARE = 0.7;

export interface LayoutOptions {
  /** Called after the layout moved, with words for why. */
  readonly onChanged: (because: string) => void;
}

export class PageLayout {
  private readonly _root: HTMLElement;
  private readonly _terminal: HTMLElement;
  /** The strip of tabs, over the terminal and inside its half (M3.9). */
  private readonly _strip: HTMLElement;
  /** Where the screens are stacked. The box a hidden screen still has a size in. */
  private readonly _screens: HTMLElement;
  private readonly _splitter: HTMLElement;
  private readonly _details: HTMLElement;
  private readonly _options: LayoutOptions;
  /** The person's last wish for the terminal half; `null` until they say. */
  private _wanted: number | null = null;

  constructor(root: HTMLElement, options: LayoutOptions) {
    this._root = root;
    this._options = options;
    this._terminal = document.createElement('div');
    this._terminal.className = 'gripterm-terminal';
    // The strip sits over the terminal and NOT over the whole page (the owner's
    // decision of 2026-08-18): it moves with the border, and the details half
    // keeps its own heading where it is.
    this._strip = document.createElement('div');
    this._strip.className = 'gripterm-strip';
    this._strip.setAttribute('role', 'tablist');
    this._screens = document.createElement('div');
    this._screens.className = 'gripterm-screens';
    this._terminal.append(this._strip, this._screens);
    this._splitter = document.createElement('div');
    this._splitter.className = 'gripterm-splitter';
    this._splitter.setAttribute('role', 'separator');
    this._splitter.setAttribute('aria-orientation', 'vertical');
    this._details = document.createElement('div');
    this._details.className = 'gripterm-details';
    // So that the keyboard can be somewhere that is not the terminal -- see
    // `focusDetails`.
    this._details.tabIndex = 0;
    root.append(this._terminal, this._splitter, this._details);

    this._splitter.addEventListener('pointerdown', (event) => { this._startDrag(event); });
    new ResizeObserver(() => {
      this.apply();
      this._options.onChanged('the panel changed size');
    }).observe(this._root);
  }

  /** Where the screens live: the terminal half under the strip. */
  public get screensHost(): HTMLElement {
    return this._screens;
  }

  /** Where the tabs are drawn. */
  public get stripHost(): HTMLElement {
    return this._strip;
  }

  /** Where the details half is drawn (M3.11). Empty until it is told anything. */
  public get detailsHost(): HTMLElement {
    return this._details;
  }

  public get terminalWidth(): number {
    return this._terminal.getBoundingClientRect().width;
  }

  public get detailsWidth(): number {
    return this._details.getBoundingClientRect().width;
  }

  /**
   * Puts the keyboard into the details half.
   *
   * It is focusable at all because of O6: the half is part of the same document
   * as the terminal, and "the terminal has the keyboard" has to be a question
   * with a false answer -- otherwise the chords this build takes from the editor
   * would be taken while a person is writing a note. The half itself takes the
   * focus rather than a field inside it: since M3.11 it holds the record, the
   * notes and the history, and none of those is edited here.
   */
  public focusDetails(): void {
    this._details.focus();
  }

  /** Lays the halves out again, or leaves them alone when there is no room to. */
  public apply(): void {
    const total = this._root.getBoundingClientRect().width;
    const split = resolveSplit({
      total,
      divider: DIVIDER_PX,
      wanted: this._wanted ?? total * TERMINAL_SHARE,
      minTerminal: MIN_TERMINAL_PX,
      minDetails: MIN_DETAILS_PX,
    });
    if (split === null) {
      // A hidden panel is a box of zero, and a layout computed from it would
      // reach xterm as a resize to nothing. The last good split stays.
      return;
    }
    this._terminal.style.flex = `0 0 ${String(split.terminal)}px`;
    this._details.style.flex = `0 0 ${String(split.details)}px`;
  }

  /**
   * Drags the border by hand, on somebody else's order.
   *
   * Real pointer events at the real element, so that what a probe exercises is
   * the path a person's mouse takes and not a second implementation of it.
   */
  public dragBy(px: number): void {
    const box = this._splitter.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    this._splitter.dispatchEvent(pointer('pointerdown', x, y));
    window.dispatchEvent(pointer('pointermove', x + px, y));
    window.dispatchEvent(pointer('pointerup', x + px, y));
  }

  private _startDrag(event: PointerEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.terminalWidth;
    this._splitter.classList.add('gripterm-dragging');

    const move = (moved: PointerEvent): void => {
      this._want(startWidth + (moved.clientX - startX));
    };
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      this._splitter.classList.remove('gripterm-dragging');
    };
    // On `window` rather than through `setPointerCapture`: capture belongs to a
    // pointer the browser is tracking, and a synthetic event has none -- the
    // probe would then take a different path from the mouse, which is the one
    // thing a probe may not do.
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  }

  private _want(terminalPx: number): void {
    this._wanted = terminalPx;
    this.apply();
    this._options.onChanged('the border was dragged');
  }
}

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
}
