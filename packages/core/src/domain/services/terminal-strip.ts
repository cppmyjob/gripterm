import { arranged } from './terminal-order';
import { presentTerminal } from './terminal-presentation';
import type { TerminalEntry } from '../entities/terminal-entry';
import type { TerminalState } from '../entities/terminal-state';

/**
 * The strip of tabs over the panel's terminal: one tab per terminal the panel
 * is holding, in the order it took them.
 *
 * It is a rule and not a drawing, which is why it lives here. What a tab looks
 * like is `presentTerminal`'s answer already -- the same one the tree draws its
 * rows from -- so the strip cannot come to a different conclusion about a
 * terminal than the list two panels away does. What this file adds is the two
 * things only the panel knows: which tab is the one on screen, and which
 * terminals still have a process behind them.
 *
 * **Attention is a function of the state and of nothing remembered.** The mark
 * is on a tab whose agent is waiting for the person AND which is not the tab
 * they are looking at. That is the owner's decision of 2026-08-18 -- "it goes
 * out when you switch to it" -- and writing it this way rather than as a flag
 * cleared on a click means there is no second copy of the truth: a person who
 * switches away from an agent that is still waiting sees the mark come back,
 * because the agent is still waiting.
 */

/** How one tab is drawn. Strings and ids only: the page is a document, not an editor. */
export interface StripTab {
  readonly terminalId: string;
  readonly label: string;
  /** A `ThemeIcon` id, modifier and all -- `sync~spin` is one value, not two. */
  readonly iconId: string;
  /** A theme colour id for the icon, or `null` to leave the page's own. */
  readonly colorId: string | null;
  readonly active: boolean;
  readonly attention: boolean;
  /** Whether the process behind this terminal is gone. The tab stays; it dims. */
  readonly over: boolean;
}

/**
 * The states that put a mark on a tab: the two where an agent is stopped,
 * waiting for a person, and will stay stopped until it gets one.
 *
 * The owner's decision of 2026-08-18. Deliberately NOT the same list as
 * `DEFAULT_TOAST_SIGNALS`: a toast interrupts and so it is spent on the things
 * that would otherwise never be mentioned, while this mark sits quietly on a
 * tab the person is going to look at anyway. A failure already has an icon and a
 * colour of its own here (`presentTerminal`), so marking it as well would make
 * the mark mean "something is not ordinary" -- which is every terminal, some
 * days.
 */
export const ATTENTION_STATES: readonly TerminalState[] = ['waiting_permission', 'waiting_input'];

export interface StripInput {
  /**
   * Every terminal the panel is holding, in whatever order it took them.
   *
   * The order it took them in is NOT the order they are drawn in, and that is
   * the owner's decision of 2026-08-21: after a restart "the order it took
   * them" is the order the store handed the records over, which is the order
   * the filesystem lists uuid-named directories. What decides is the
   * arrangement on the record (`placement`), so the strip and the tree agree
   * and a restart cannot change either.
   */
  readonly held: readonly string[];
  /** Those of them that still have a process. The rest have ended and are kept to be read. */
  readonly running: readonly string[];
  /** The one on screen, or `null` when the panel is showing none of them. */
  readonly active: string | null;
  /** What this window knows about its terminals. A held terminal may be missing from it. */
  readonly entries: readonly TerminalEntry[];
}

/** What a tab says when the panel holds a terminal no record describes. */
const UNNAMED = 'terminal';
const UNKNOWN_ICON = 'question';
const OVER_ICON = 'circle-slash';

/**
 * The strip, from what the panel holds and what the window knows.
 *
 * `presentTerminal` is asked without a context, and that is exact rather than
 * lazy: the panel holds this window's OWN terminals and nothing else, so both
 * of its defaults -- ours, and an owner that is answering -- are the truth here.
 *
 * A held terminal with no record still gets a tab. It is a defect somewhere
 * else if it happens, and the alternative is worse: a tab that quietly
 * disappears while its screen stays on the stack is a terminal a person cannot
 * reach and cannot close.
 */
export function stripTabs(input: StripInput): readonly StripTab[] {
  const known = new Map(input.entries.map((entry) => [entry.terminalId.value, entry]));
  // Held terminals with a record, in the arrangement; then the ones no record
  // describes, in the order the panel has them. Guessing a place for those would
  // move tabs that do have one.
  const placed = arranged(input.entries.filter((entry) => input.held.includes(entry.terminalId.value)))
    .map((entry) => entry.terminalId.value);
  const strangers = input.held.filter((terminalId) => !known.has(terminalId));
  return [...placed, ...strangers].map((terminalId) => {
    const active = terminalId === input.active;
    const over = !input.running.includes(terminalId);
    const entry = known.get(terminalId);
    if (entry === undefined) {
      return {
        terminalId,
        label: UNNAMED,
        iconId: over ? OVER_ICON : UNKNOWN_ICON,
        colorId: null,
        active,
        attention: false,
        over,
      };
    }
    const shown = presentTerminal(entry);
    return {
      terminalId,
      label: shown.label,
      iconId: shown.iconId,
      colorId: shown.colorId,
      active,
      attention: !active && ATTENTION_STATES.includes(shown.state),
      over,
    };
  });
}
