import { TerminalEntry } from '../entities/terminal-entry';
import { TerminalId } from '../entities/terminal-id';

/**
 * Which terminal a command was invoked on.
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
 * Everything unrecognised -- including a string that is not a uuid -- comes back
 * as `null` rather than as a guess. The caller then says so; a wrong terminal is
 * worse than none, because closing is one of the things these commands do.
 */
export function terminalIdFrom(target: unknown): TerminalId | null {
  if (target instanceof TerminalEntry) {
    return target.terminalId;
  }
  return typeof target === 'string' ? TerminalId.tryFromString(target) : null;
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
