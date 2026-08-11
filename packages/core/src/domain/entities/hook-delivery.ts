import type { TerminalId } from './terminal-id';

/**
 * One hook payload as it arrived, before anyone has decided what it means.
 *
 * `raw` is a STRING and stays one all the way to the journal. Storing our
 * reading of the payload instead would store the part most likely to be wrong:
 * Claude Code emits over thirty event types, adds more between builds, and the
 * eleven we model are the eleven we happen to understand today. A body kept
 * verbatim can be re-read by a later version; a body parsed and discarded
 * cannot, and §I.3 has no remedy for it.
 *
 * `terminalId` comes from the URL path and is the ADDRESS of the record. The
 * `session_id` inside the body is a different identifier that drifts on
 * `/clear`; comparing the two is the drift detector (§4.6), and neither
 * substitutes for the other.
 */
export interface HookDelivery {
  readonly terminalId: TerminalId;
  readonly receivedAt: Date;
  readonly raw: string;
}
