import { codiconClasses, themeColorVariable } from '../tab-look';
import type { DetailsOrder, DetailsReport } from '../protocol';

/**
 * The details half: what Gripterm knows about the terminal on the left.
 *
 * It draws what it is told and REPORTS WHAT IT DREW, for the reason the strip
 * does: everything that can go wrong in a document is silent. An icon class the
 * stylesheet has no rule for leaves a blank space, a fact left out looks exactly
 * like a fact the record never had, and a half that stopped redrawing looks
 * exactly like a terminal that has not changed. So the report carries the text
 * read back off the elements, the glyph the font really put beside the heading,
 * and the number of times this half has been drawn.
 *
 * It decides nothing at all. Every word about a terminal arrives in the order,
 * from one rule in the core (`describeTerminal`), so the half and the tree
 * cannot come to different conclusions. What the page adds is the two things
 * that belong to a document and cannot be decided in a rule: the headings above
 * each part, and the MOMENTS -- a time is rendered here because the person's
 * own clock and locale are known here and nowhere else.
 */

/** The glyph a browser reports for an element whose class draws nothing. */
const NO_GLYPH = 'none';

/**
 * What the half says before the host has said anything.
 *
 * Its own words rather than the rule's: this is the page's statement about the
 * PAGE -- built, waiting, not yet told anything -- and it is drawn because a
 * blank rectangle is the one thing this half may never be (M3.11). If it is
 * still on screen a moment later, that is a message that never arrived, and the
 * sentence is what makes it visible.
 */
const BEFORE_ANY_ORDER = 'Waiting for Gripterm…';

export class PageDetails {
  private readonly _host: HTMLElement;
  private _drawn: DetailsOrder | null = null;
  private _draws = 0;
  /** The last icon element drawn, for the glyph the report reads back. */
  private _icon: HTMLElement | null = null;
  private readonly _refused: (what: string) => void;

  constructor(host: HTMLElement, onRefused: (what: string) => void) {
    this._host = host;
    this._refused = onRefused;
    const waiting = document.createElement('p');
    waiting.className = 'gripterm-details-nothing';
    waiting.textContent = BEFORE_ANY_ORDER;
    this._host.replaceChildren(waiting);
  }

  /**
   * Draws the half again, whole, every time.
   *
   * A redraw and not a patch, for the reason the strip is redrawn: a half built
   * from differences drifts the moment a message is missed, and a drifted half
   * is a person reading yesterday's task about today's agent.
   */
  public draw(view: DetailsOrder): void {
    this._drawn = view;
    this._draws += 1;
    this._icon = null;
    const parts: HTMLElement[] = [];

    if (view.headline !== null) {
      parts.push(this._head(view));
    }
    if (view.nothing !== null) {
      const nothing = document.createElement('p');
      nothing.className = 'gripterm-details-nothing';
      nothing.textContent = view.nothing;
      parts.push(nothing);
    }
    const facts = this._facts(view);
    if (facts !== null) {
      parts.push(facts);
    }
    if (view.task !== null) {
      parts.push(section('Task', paragraph(view.task, 'gripterm-details-task')));
    }
    if (view.notes.length > 0) {
      parts.push(section(`Notes (${String(view.notes.length)})`, this._notes(view)));
    }
    if (view.headline !== null) {
      parts.push(section('History', this._events(view)));
    }
    if (view.notices.length > 0) {
      parts.push(this._notices(view));
    }

    this._host.replaceChildren(...parts);
    this._toTheEnd();
  }

  /** The half as it really is on screen, read back off the document. */
  public report(): DetailsReport {
    return {
      terminalId: this._drawn?.headline?.terminalId ?? null,
      nothing: this._textOf('.gripterm-details-nothing'),
      headline: this._textOf('.gripterm-details-head') ?? '',
      glyph: this._icon === null ? NO_GLYPH : glyphOf(this._icon),
      // Read back off the elements rather than echoed from the order: a report
      // that repeated what it was TOLD would say a fact is on screen whether or
      // not anything was drawn, which is the one question this report exists to
      // answer.
      facts: this._each('.gripterm-details-fact'),
      task: this._textOf('.gripterm-details-task'),
      notes: this._host.querySelectorAll('.gripterm-details-note').length,
      events: this._each('.gripterm-details-event'),
      notices: this._each('.gripterm-details-notice'),
      draws: this._draws,
    };
  }

  private _head(view: DetailsOrder): HTMLElement {
    const head = document.createElement('div');
    head.className = 'gripterm-details-head';
    const headline = view.headline;
    if (headline === null) {
      return head;
    }
    head.classList.toggle('gripterm-details-over', headline.over);

    const icon = document.createElement('span');
    icon.className = 'gripterm-details-icon';
    const classes = codiconClasses(headline.iconId);
    if (classes === null) {
      // Said out loud and drawn as nothing rather than quietly substituted, as
      // in the strip: an icon replaced in silence is one state shown as another.
      this._refused(`an icon this page cannot draw: ${headline.iconId}`);
    } else {
      icon.classList.add(...classes);
    }
    if (headline.colorId !== null) {
      const variable = themeColorVariable(headline.colorId);
      if (variable === null) {
        this._refused(`a colour this page cannot read: ${headline.colorId}`);
      } else {
        icon.style.color = `var(${variable})`;
      }
    }
    this._icon = icon;

    const name = document.createElement('h2');
    name.className = 'gripterm-details-name';
    name.textContent = headline.label;
    const state = document.createElement('span');
    state.className = 'gripterm-details-state';
    state.textContent = headline.words;

    head.append(icon, name, state);
    return head;
  }

  /**
   * The record, as a description list.
   *
   * The two moments are added HERE and not in the rule, and their names with
   * them: a moment becomes words only against a clock and a locale, and this is
   * the only side of the channel that has either.
   */
  private _facts(view: DetailsOrder): HTMLElement | null {
    const rows: (readonly [string, string])[] = view.facts.map((fact) => [fact.name, fact.value]);
    if (view.startedAtMs !== null) {
      rows.push(['started', moment(view.startedAtMs)]);
    }
    if (view.lastEventAtMs !== null) {
      rows.push(['last event', moment(view.lastEventAtMs)]);
    }
    if (rows.length === 0) {
      return null;
    }
    const list = document.createElement('dl');
    list.className = 'gripterm-details-facts';
    for (const [name, value] of rows) {
      const term = document.createElement('dt');
      term.textContent = name;
      const said = document.createElement('dd');
      said.className = 'gripterm-details-fact';
      said.textContent = value;
      // The whole row in one attribute, so that a report of `name: value` is
      // read off the document rather than assembled from two queries that could
      // fall out of step.
      said.dataset.fact = `${name}: ${value}`;
      list.append(term, said);
    }
    return list;
  }

  private _notes(view: DetailsOrder): HTMLElement {
    const list = document.createElement('ul');
    list.className = 'gripterm-details-notes';
    for (const note of view.notes) {
      const item = document.createElement('li');
      item.className = 'gripterm-details-note';
      const when = document.createElement('time');
      when.textContent = moment(note.atMs);
      const said = document.createElement('span');
      said.textContent = note.text;
      item.append(when, said);
      list.append(item);
    }
    return list;
  }

  private _events(view: DetailsOrder): HTMLElement {
    const list = document.createElement('ol');
    list.className = 'gripterm-details-events';
    for (const event of view.events) {
      const item = document.createElement('li');
      item.className = 'gripterm-details-event';
      const when = document.createElement('time');
      when.textContent = clockTime(event.atMs);
      const said = document.createElement('span');
      said.textContent = event.words;
      item.dataset.fact = event.words;
      item.append(when, said);
      list.append(item);
    }
    return list;
  }

  private _notices(view: DetailsOrder): HTMLElement {
    const list = document.createElement('ul');
    list.className = 'gripterm-details-notices';
    for (const notice of view.notices) {
      const item = document.createElement('li');
      item.className = 'gripterm-details-notice';
      item.textContent = notice;
      list.append(item);
    }
    return list;
  }

  /** Keeps the newest event in view: a history is read from its end. */
  private _toTheEnd(): void {
    const events = this._host.querySelector('.gripterm-details-events');
    if (events !== null) {
      events.scrollTop = events.scrollHeight;
    }
  }

  private _textOf(selector: string): string | null {
    const found = this._host.querySelector(selector);
    return found === null ? null : (found.textContent ?? '');
  }

  private _each(selector: string): readonly string[] {
    return [...this._host.querySelectorAll<HTMLElement>(selector)].map(
      (element) => element.dataset.fact ?? element.textContent ?? ''
    );
  }
}

function section(title: string, body: HTMLElement): HTMLElement {
  const box = document.createElement('section');
  box.className = 'gripterm-details-section';
  const heading = document.createElement('h3');
  heading.textContent = title;
  box.append(heading, body);
  return box;
}

function paragraph(text: string, className: string): HTMLElement {
  const said = document.createElement('p');
  said.className = className;
  said.textContent = text;
  return said;
}

/** A moment in the person's own words. Their clock, their locale, their zone. */
function moment(atMs: number): string {
  return new Date(atMs).toLocaleString();
}

/** The time of day alone: a history read at a glance does not repeat the date. */
function clockTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString();
}

/** The character the icon font really put in this element. See `strip.ts`. */
function glyphOf(icon: HTMLElement): string {
  const content = getComputedStyle(icon, '::before').content;
  if (content === NO_GLYPH || content === '') {
    return NO_GLYPH;
  }
  return content.replaceAll('"', '');
}
