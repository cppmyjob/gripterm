import type { IdGenerator } from '../ports/id-generator';
import { parseUuid } from './uuid';

/**
 * The Claude Code CLI's identifier for a conversation. Ours to carry, not ours
 * to own: it changes under `/clear`, `/branch` and `--fork-session`, and each
 * time the previous value moves into `TerminalEntry.sessionIdHistory` so that
 * late events from the dying session still find their terminal.
 *
 * Same shape as `TerminalId` and deliberately not the same type -- see the note
 * there.
 */
export class SessionId {
  /** Nominal marker -- see the note on `TerminalId._nominal`. */
  private declare readonly _nominal: 'SessionId';

  private constructor(public readonly value: string) {
    Object.freeze(this);
  }

  /**
   * Mints a new one. We do supply the session id at launch, with
   * `--session-id`, which is what makes hook events attributable before the CLI
   * has said anything back.
   */
  public static create(generator: IdGenerator): SessionId {
    return SessionId.fromString(generator.newUuid());
  }

  /** Throws `ValidationError` when `raw` is not shaped like a UUID. */
  public static fromString(raw: string): SessionId {
    return new SessionId(parseUuid(raw, 'sessionId'));
  }

  /**
   * The same, for a string that arrived from outside and was never promised to
   * be an id -- the twin of `TerminalId.tryFromString`, and here it has a
   * measured reason rather than a symmetrical one.
   *
   * `claude agents --json` does not validate the field: a session record whose
   * `sessionId` was the text `not-a-uuid` reached the output verbatim
   * (2026-08-12, A24). Such an id can equal nothing we ever minted, so it is
   * nothing to us -- but reading the list must not become an exception on the
   * restore path over it.
   */
  public static tryFromString(raw: string): SessionId | null {
    try {
      return SessionId.fromString(raw);
    } catch {
      return null;
    }
  }

  public equals(other: SessionId): boolean {
    return this.value === other.value;
  }

  public toString(): string {
    return this.value;
  }
}
