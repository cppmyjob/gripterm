import { codiconClasses, themeColorVariable } from '../tab-look';
import { insertionIndex } from '../drop-rule';
import type { TabOrder, TabReport } from '../protocol';

/**
 * The strip of tabs over the terminal.
 *
 * It draws what it is told and REPORTS WHAT IT DREW, and the second half is the
 * whole reason this file can be trusted at all. Everything that can go wrong
 * here is silent: a codicon class the stylesheet has no rule for leaves an empty
 * space, a theme colour that does not resolve is ignored by the browser without
 * a word, and both look exactly like a tab that is simply plain. So the report
 * carries the glyph the font actually put in the tab and the colour the editor's
 * own variable actually resolved to -- two facts a suite can be wrong about, in
 * place of a screenshot nobody looks at.
 *
 * It decides nothing. Which tab is active, which is marked, which one's process
 * has gone: all of it arrives in the message, from one rule in the core
 * (`stripTabs`), so the strip and the tree cannot come to different conclusions
 * about the same terminal.
 */

/** What the mark of a waiting agent is drawn with. A dot, in the icon font. */
const MARK_ICON = 'circle-filled';

/** What the cross is drawn with. */
const CLOSE_ICON = 'close';

/** The glyph a browser reports for an element whose class draws nothing. */
const NO_GLYPH = 'none';

/*
 * The three classes the report is read back through. Named rather than spelled
 * twice, because a report that looked for a class the tab is not drawn with
 * would answer "no" for every tab and nothing would notice.
 */
const ACTIVE_CLASS = 'gripterm-tab-active';
const OVER_CLASS = 'gripterm-tab-over';
const MARK_CLASS = 'gripterm-tab-mark';

/*
 * What a drag looks like while it is happening. Three classes and no state
 * anywhere else: the strip is redrawn whole on every change (see `draw`), so a
 * flag kept beside the DOM would be a second truth that outlives the elements it
 * described.
 */
/** How far into the target half the probe puts its pointer: a quarter of the tab. */
const QUARTER_TAB = 4;

const DRAGGING_CLASS = 'gripterm-tab-dragging';
const BEFORE_CLASS = 'gripterm-tab-drop-before';
const AFTER_CLASS = 'gripterm-tab-drop-after';

export interface StripOptions {
  /** The person clicked a tab: they want this terminal on screen. */
  readonly onChose: (terminalId: string) => void;
  /** The person clicked the cross on a tab. */
  readonly onClose: (terminalId: string) => void;
  /** Something could not be drawn, in words -- an icon id this page cannot read. */
  readonly onRefused: (what: string) => void;
  /**
   * The person dragged a tab and let go of it (owner's decision 2026-08-21).
   *
   * `toIndex` is where the tab will stand once it has moved, which is what the
   * store takes. The page does that arithmetic once, through `insertionIndex`,
   * and nothing on the host's side repeats it.
   */
  readonly onReorder: (terminalId: string, toIndex: number) => void;
}

interface DrawnTab {
  readonly terminalId: string;
  readonly root: HTMLElement;
  readonly icon: HTMLElement;
  readonly label: HTMLElement;
  readonly close: HTMLElement;
  /** The variable the icon's colour was taken from, or `null` when the state had none. */
  readonly colourVariable: string | null;
}

export class PageStrip {
  private readonly _host: HTMLElement;
  private readonly _options: StripOptions;
  private _drawn: DrawnTab[] = [];
  /**
   * The tab a hand is holding right now, or `null`.
   *
   * Kept here rather than in `dataTransfer`, and that is what makes a drag from
   * OUTSIDE the page -- a file dragged onto the strip -- an ordinary no-op: this
   * is null then, nothing is prevented, and the editor does whatever it does
   * with dropped files.
   */
  private _dragging: string | null = null;

  constructor(host: HTMLElement, options: StripOptions) {
    this._host = host;
    this._options = options;
  }

  /**
   * Draws the whole strip again, every time.
   *
   * A redraw rather than a patch, for the reason every list in this build is
   * sent whole (M2.5): a strip built from differences drifts the moment one
   * message is missed, and a strip that has drifted is a person clicking the tab
   * of an agent that is not there.
   */
  public draw(tabs: readonly TabOrder[]): void {
    this._host.replaceChildren();
    this._drawn = tabs.map((tab) => this._tab(tab));
    // Drawn from the FIRST tab and not from the second. A strip that appeared
    // only once there was something to switch between would leave a single
    // ended terminal with no cross to click -- and its screen would then stay
    // on the stack, unreachable, for as long as the window is open.
    this._host.style.display = tabs.length > 0 ? 'flex' : 'none';
  }

  /** The strip as it really is on screen, read back off the document. */
  public report(): readonly TabReport[] {
    const style = getComputedStyle(document.body);
    return this._drawn.map((tab) => ({
      terminalId: tab.terminalId,
      label: tab.label.textContent ?? '',
      // Read off the tab rather than kept from the order that drew it. A report
      // that echoed what it was TOLD would say a mark is there whether or not
      // anything was drawn -- which is the one thing this report exists to
      // answer, and a mutation that stopped drawing the mark survived exactly
      // that way (I4, 2026-08-18).
      active: tab.root.classList.contains(ACTIVE_CLASS),
      attention: tab.root.querySelector(`.${MARK_CLASS}`) !== null,
      over: tab.root.classList.contains(OVER_CLASS),
      glyph: glyphOf(tab.icon),
      colour: tab.colourVariable === null ? '' : style.getPropertyValue(tab.colourVariable).trim(),
    }));
  }

  /**
   * Clicks a tab, or its cross, the way a person's mouse does.
   *
   * A real event on the real element, so what runs afterwards is the handler
   * below and the message it posts -- not a second implementation of either.
   * `false` when there is no such tab, which the page says out loud: a probe
   * aimed at a terminal the strip does not have is a defect in the suite or in
   * the host, and a silent no-op would make it look like a defect in the strip.
   */
  public click(terminalId: string, theCross: boolean): boolean {
    const tab = this._drawn.find((drawn) => drawn.terminalId === terminalId);
    if (tab === undefined) {
      return false;
    }
    const target = theCross ? tab.close : tab.root;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }

  /**
   * Drags one tab onto another, the way a person's hand does.
   *
   * Real events on the real elements, so what runs afterwards is the handler
   * below, the rule it calls and the message it posts -- not a second
   * implementation of any of them. The pointer is put on the half of the target
   * the caller asked for, by measuring the element, because "which half" is the
   * whole of what decides before or after.
   *
   * `false` when either tab is missing, said out loud for the reason `click`
   * says it: a probe aimed at a tab the strip does not have is a defect in the
   * suite or in the host, and a silent no-op would look like one in the page.
   */
  public dragTab(terminalId: string, over: string, afterMidpoint: boolean): boolean {
    const source = this._drawn.find((drawn) => drawn.terminalId === terminalId);
    const target = this._drawn.find((drawn) => drawn.terminalId === over);
    if (source === undefined || target === undefined) {
      return false;
    }
    const box = target.root.getBoundingClientRect();
    const quarter = box.width / QUARTER_TAB;
    const clientX = afterMidpoint ? box.right - quarter : box.left + quarter;
    source.root.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));
    target.root.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX }));
    target.root.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX }));
    source.root.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }));
    return true;
  }

  private _tab(tab: TabOrder): DrawnTab {
    const root = document.createElement('div');
    root.className = 'gripterm-tab';
    root.dataset.terminalId = tab.terminalId;
    root.setAttribute('role', 'tab');
    root.setAttribute('aria-selected', String(tab.active));
    root.classList.toggle(ACTIVE_CLASS, tab.active);
    root.classList.toggle(OVER_CLASS, tab.over);

    const icon = this._icon(tab.iconId);
    const colourVariable = this._colour(icon, tab.colorId);
    const label = document.createElement('span');
    label.className = 'gripterm-tab-label';
    label.textContent = tab.label;
    // The whole of what is known about this terminal is elsewhere (the list, and
    // the details half of M3.11); the title is what a strip too narrow for the
    // name still answers.
    root.title = tab.label;

    root.append(icon, label);
    if (tab.attention) {
      root.append(this._mark());
    }
    const close = this._close(tab.terminalId);
    root.append(close);

    root.addEventListener('click', () => { this._options.onChose(tab.terminalId); });
    this._makeDraggable(root, tab.terminalId);
    this._host.append(root);
    return {
      terminalId: tab.terminalId,
      root,
      icon,
      label,
      close,
      colourVariable,
    };
  }

  /**
   * What makes one tab draggable, and what happens when another is let go on it.
   *
   * The owner asked for this on 2026-08-21, in the same breath as the order that
   * kept changing by itself: an order a person cannot correct is worse than no
   * order at all, because they can see it is wrong and can do nothing about it.
   */
  private _makeDraggable(root: HTMLElement, terminalId: string): void {
    root.draggable = true;
    root.addEventListener('dragstart', (event) => {
      this._dragging = terminalId;
      root.classList.add(DRAGGING_CLASS);
      // Some editors refuse to start a drag whose transfer carries nothing.
      event.dataTransfer?.setData('text/plain', terminalId);
    });
    root.addEventListener('dragend', () => {
      this._dragging = null;
      this._clearDropMarks();
      root.classList.remove(DRAGGING_CLASS);
    });
    root.addEventListener('dragover', (event) => {
      if (this._dragging === null) {
        // Somebody dragged something that is not a tab -- a file, most likely.
        // Nothing is prevented, so the editor does whatever it does with it.
        return;
      }
      // Without this the browser refuses the drop outright, and the whole
      // gesture ends in the "no" cursor.
      event.preventDefault();
      this._clearDropMarks();
      root.classList.add(this._afterMidpoint(event, root) ? AFTER_CLASS : BEFORE_CLASS);
    });
    root.addEventListener('dragleave', () => {
      root.classList.remove(BEFORE_CLASS, AFTER_CLASS);
    });
    root.addEventListener('drop', (event) => {
      const moved = this._dragging;
      if (moved === null) {
        return;
      }
      event.preventDefault();
      this._clearDropMarks();
      this._dragging = null;
      const from = this._drawn.findIndex((drawn) => drawn.terminalId === moved);
      const onto = this._drawn.findIndex((drawn) => drawn.terminalId === terminalId);
      if (from === -1 || onto === -1) {
        return;
      }
      this._options.onReorder(
        moved,
        insertionIndex({ from, over: onto, afterMidpoint: this._afterMidpoint(event, root) })
      );
    });
  }

  /** Which half of the tab the pointer is over. The middle counts as the left one. */
  private _afterMidpoint(event: DragEvent, root: HTMLElement): boolean {
    const box = root.getBoundingClientRect();
    return event.clientX > box.left + box.width / 2;
  }

  private _clearDropMarks(): void {
    for (const drawn of this._drawn) {
      drawn.root.classList.remove(BEFORE_CLASS, AFTER_CLASS);
    }
  }

  private _icon(iconId: string): HTMLElement {
    const icon = document.createElement('span');
    icon.className = 'gripterm-tab-icon';
    const classes = codiconClasses(iconId);
    if (classes === null) {
      // Said out loud and drawn as nothing rather than quietly substituted: an
      // icon replaced in silence is one state reported as another, which is the
      // one thing an icon exists to prevent.
      this._options.onRefused(`an icon this page cannot draw: ${iconId}`);
      return icon;
    }
    icon.classList.add(...classes);
    return icon;
  }

  /** Paints the icon in the state's colour, and says which variable it took. */
  private _colour(icon: HTMLElement, colorId: string | null): string | null {
    if (colorId === null) {
      return null;
    }
    const variable = themeColorVariable(colorId);
    if (variable === null) {
      this._options.onRefused(`a colour this page cannot read: ${colorId}`);
      return null;
    }
    icon.style.color = `var(${variable})`;
    return variable;
  }

  private _mark(): HTMLElement {
    const mark = document.createElement('span');
    mark.className = MARK_CLASS;
    mark.classList.add(...(codiconClasses(MARK_ICON) ?? []));
    mark.title = 'waiting for you';
    return mark;
  }

  private _close(terminalId: string): HTMLElement {
    const close = document.createElement('span');
    close.className = 'gripterm-tab-close';
    close.classList.add(...(codiconClasses(CLOSE_ICON) ?? []));
    close.title = 'Close terminal';
    close.setAttribute('role', 'button');
    close.addEventListener('click', (event) => {
      // Or the click would also be a choice, and the last thing a person sees
      // before a terminal closes would be it being switched to.
      event.stopPropagation();
      this._options.onClose(terminalId);
    });
    return close;
  }
}

/**
 * The character the icon font really put in this element.
 *
 * `content` comes back quoted -- `""` -- and comes back as the word `none`
 * when the class matches no rule at all, which is exactly what a `ThemeIcon` id
 * carried across without being split produces. Reported as it is, quotes
 * removed, so a suite can tell a glyph from an empty space.
 */
function glyphOf(icon: HTMLElement): string {
  const content = getComputedStyle(icon, '::before').content;
  if (content === NO_GLYPH || content === '') {
    return NO_GLYPH;
  }
  return content.replaceAll('"', '');
}
