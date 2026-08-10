import { ValidationError } from '../errors/gripterm-error';

/**
 * Deliberately shape-only: eight-four-four-four-twelve hexadecimal digits, case
 * insensitive. The version and variant nibbles are NOT pinned.
 *
 * The reason is asymmetric cost. We mint `TerminalId` ourselves and could
 * afford to be strict, but `SessionId` arrives from the Claude Code CLI and we
 * only carry it. Rejecting an id the CLI actually issued would turn a record we
 * could have kept into a hard failure, while accepting a technically
 * non-conforming one costs nothing: the value is used as an address, never
 * decoded.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns the value lowercased, so that two ids differing only in case are the
 * same key everywhere -- in a Map, in a file name, in an equality test.
 */
export function parseUuid(raw: string, label: string): string {
  if (!UUID_SHAPE.test(raw)) {
    throw new ValidationError(`${label} must be a UUID`, { details: { label, raw } });
  }
  return raw.toLowerCase();
}
