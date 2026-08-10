import { TerminalId } from '../entities/terminal-id';
import type { ListeningAddress } from '../entities/listening-address';

/**
 * The route hook payloads arrive on. Short on purpose: the whole URL is a
 * literal inside `settings.json`, which a person reads when something breaks.
 */
export const HOOK_EVENT_PATH_PREFIX = '/ev/';

/**
 * Where Claude Code posts this terminal's events.
 *
 * The terminal id travels in the PATH, and that is a decision rather than a
 * convenience. The body carries `session_id`, which is a different identifier
 * and drifts on `/clear`, `/branch` and `--fork-session`; routing on it would
 * lose a terminal the moment its conversation was replaced. The two are
 * compared instead, and their disagreement is the drift detector (§4.6).
 */
export function hookEventUrl(address: ListeningAddress, terminalId: TerminalId): string {
  return `${address.origin}${HOOK_EVENT_PATH_PREFIX}${terminalId.value}`;
}

/**
 * The reader's half of the contract above, kept in the same module so that the
 * two cannot drift apart. A mismatch between them is not a 404 anyone would
 * notice: it is a terminal that stays `launching` while its process works.
 *
 * Returns `null` for anything it does not recognise -- an unknown path is a
 * request to answer 404, never a reason to throw inside a request handler.
 */
export function parseHookEventPath(pathname: string): TerminalId | null {
  if (!pathname.startsWith(HOOK_EVENT_PATH_PREFIX)) {
    return null;
  }
  try {
    // `TerminalId` owns what a valid id looks like. Repeating its shape here
    // would be a second definition free to drift from the first; the throw is
    // the only way to ask it, so the throw is what is used.
    return TerminalId.fromString(pathname.slice(HOOK_EVENT_PATH_PREFIX.length));
  } catch {
    return null;
  }
}
