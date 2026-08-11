import type { HookDelivery } from '../entities/hook-delivery';
import type { TerminalId } from '../entities/terminal-id';

/**
 * Whoever turns deliveries into state. `SessionRegistry` implements it in M1.9;
 * the receiver is written against this and never against the registry, so M1.8
 * can be finished, tested and reasoned about before M1.9 exists.
 *
 * The two methods differ in kind, and that is the whole design.
 *
 * `knows` is SYNCHRONOUS and cheap because it runs on the request path: the
 * receiver has to answer 404 for a terminal that is not ours BEFORE it reads a
 * body, or the port becomes a way to invent records from outside (§4.6). An
 * in-memory projection can answer it in a lookup, and the registry is one.
 *
 * `receive` runs AFTER the response has gone out and returns nothing. There is
 * no outcome to report because there is nobody left to report it to -- the
 * conversation was answered a moment ago, and holding it open for our own
 * bookkeeping is what the default ten-minute hook timeout would have cost us.
 */
export interface HookEventSink {
  knows: (terminalId: TerminalId) => boolean;
  receive: (delivery: HookDelivery) => void;
}
