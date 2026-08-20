import { TerminalEntry } from '../entities/terminal-entry';
import { TerminalId } from '../entities/terminal-id';

/**
 * Which terminal a command was invoked on -- and, when the answer is none, WHICH
 * of the two ways of having none it is.
 *
 * An editor command is reachable from three places and each hands over
 * something different: a notification button passes the argument we put in it
 * (a string), a menu on a tree row passes the row's ELEMENT (a `TerminalEntry`,
 * because that is what the tree is built from), and the command palette passes
 * nothing at all. A command that understood only one of them would be a menu
 * entry that silently does nothing, which is the failure this function exists
 * to make impossible.
 *
 * It lives in the domain rather than beside the commands because
 * `packages/extension` is outside the coverage thresholds (§3.5), and "what
 * counts as a terminal here" is a decision, not plumbing.
 *
 * **THREE ANSWERS RATHER THAN AN ID OR NULL, and the third one is a defect the
 * owner had to find for us (M2.21).** The tree began handing back a wrapper
 * around the entry when the list grew project headings (M2.14); this read the
 * wrapper as no id, every row menu fell through to the picker, and `Delete
 * Record` on a row answered "the record of which terminal?" -- with somebody
 * else's row under the cursor, one Enter away. Nothing logged, nothing thrown:
 * the commands could not tell "nobody said which" (ask, which is right for the
 * palette) from "I was told and could not read it" (a bug, and never a guess).
 * They can now, and they say so.
 */
export type TerminalTarget =
  /** Nothing was passed: the palette, a keybinding, `executeCommand` with no argument. */
  | { readonly kind: 'none' }
  /** Something was passed and it is not a terminal of ours. Never a guess, always said aloud. */
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'terminal', readonly terminalId: TerminalId };

export function terminalTargetOf(target: unknown): TerminalTarget {
  if (target === undefined) {
    return { kind: 'none' };
  }
  if (target instanceof TerminalEntry) {
    return { kind: 'terminal', terminalId: target.terminalId };
  }
  // A string that is not a uuid is `unreadable` and not `none`: it came from a
  // button of ours carrying the wrong thing, which is worth hearing about.
  const named = typeof target === 'string' ? TerminalId.tryFromString(target) : null;
  return named === null ? { kind: 'unreadable' } : { kind: 'terminal', terminalId: named };
}

/**
 * What a command may do when the window holds exactly ONE terminal it could act
 * on: take it, or ask about it anyway.
 *
 * A per-command answer rather than a global rule, because the two kinds of
 * command pay different prices for a wrong guess. The edit commands (M2.7) open
 * a second dialog that shows what is about to change and start from its current
 * value, and every one of them is undone by typing again -- so asking WHICH
 * first is a question with one possible answer. Closing, deleting, starting over
 * and taking over are the other kind: the picker is the last place a person sees
 * what they are about to do, and it stays.
 */
export type SoleTerminal = 'ask' | 'take';

/**
 * Which of the terminals a command may act on it should act on, before any
 * dialog is opened.
 *
 * Three answers rather than "an id or null", because the two ways of having no
 * id are different acts: there is nothing here to act on (say so and stop), and
 * there is more than one (ask). A caller given `null` for both would have to
 * re-derive which it was from the same list it just passed in.
 */
export type TerminalChoice =
  | { readonly kind: 'nothing' }
  | { readonly kind: 'ask' }
  | { readonly kind: 'take', readonly terminalId: TerminalId };

/**
 * The rule the palette needed and did not have (M2.18).
 *
 * `Gripterm: Rename Terminal` from the palette used to open the terminal picker
 * even when the window held one terminal -- and a quick pick is an empty box
 * with a list under it, which is a thing people type into. What was typed became
 * a filter, matched no row, and Enter on no row does nothing: the command was
 * working as built and looked broken.
 *
 * `take` is offered only where there is exactly one candidate. "Take the first"
 * is what it must never become: acting on a terminal the person never chose is
 * worse than one dialog too many.
 */
export function chooseTerminal(
  candidates: readonly TerminalId[],
  whenSole: SoleTerminal
): TerminalChoice {
  const [first] = candidates;
  if (first === undefined) {
    return { kind: 'nothing' };
  }
  if (candidates.length === 1 && whenSole === 'take') {
    return { kind: 'take', terminalId: first };
  }
  return { kind: 'ask' };
}

/**
 * The same candidates, with the one the person is already looking at first.
 *
 * **The owner's decision of 2026-08-20, and the half of it that was refused.**
 * The edit commands open a picker and then a box, and the two read as ONE
 * dialog to somebody who did not build them: in M3.10 the note itself was typed
 * into the picker's filter, where it matched no row and Enter did nothing, and
 * the M3.14 acceptance found the same reading again. The obvious cure -- act on
 * the terminal that is on screen and ask nothing -- is exactly what
 * `chooseTerminal` above refuses, and for the same reason: a note written into
 * a record nobody chose is worse than one dialog too many. So the row moves to
 * the top and keeps a mark on it, and the answer stays the person's.
 *
 * Generic over "things with a terminal id" so that the rule can be tested here,
 * in the domain, while the items themselves stay the editor's quick pick.
 *
 * `showing` is `null` wherever this window has no screen of its own -- the
 * editor's engine, and any window before its panel has been opened -- and the
 * order is then whatever the caller had.
 */
export function showingFirst<T extends { readonly terminalId: TerminalId }>(
  candidates: readonly T[],
  showing: TerminalId | null
): readonly T[] {
  if (showing === null) {
    return candidates;
  }
  const looked = candidates.filter((one) => one.terminalId.value === showing.value);
  return looked.length === 0
    ? candidates
    : [...looked, ...candidates.filter((one) => one.terminalId.value !== showing.value)];
}
