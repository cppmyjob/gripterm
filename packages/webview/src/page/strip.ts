import { codiconClasses, themeColorVariable } from '../tab-look';
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

export interface StripOptions {
  /** The person clicked a tab: they want this terminal on screen. */
  readonly onChose: (terminalId: string) => void;
  /** The person clicked the cross on a tab. */
  readonly onClose: (terminalId: string) => void;
  /** Something could not be drawn, in words -- an icon id this page cannot read. */
  readonly onRefused: (what: string) => void;
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
