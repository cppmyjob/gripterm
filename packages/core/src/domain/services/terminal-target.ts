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
