import type { IdGenerator } from '../ports/id-generator.js';
import { parseUuid } from './uuid.js';

/**
 * Our address for a terminal, machine-wide and permanent.
 *
 * A class rather than a `string` alias, and a different class from `SessionId`,
 * because the two are the exact pair that must never be confused: the session
 * id drifts on `/clear`, `/branch` and `--fork-session`, ours does not. With
 * two nominal types the mix-up stops being a review question and becomes a
 * compile error.
 */
export class TerminalId {
  /**
   * Nominal marker, and the thing that makes the paragraph above true.
   * TypeScript compares classes structurally: `TerminalId` and `SessionId` have
   * the same shape, so without a private member each would be assignable to the
   * other and the separation would exist only in the names. A private field
   * makes the two types compatible with nothing but themselves. `declare` keeps
   * it entirely at type level -- nothing is emitted and nothing is stored.
   */
  private declare readonly _nominal: 'TerminalId';

  private constructor(public readonly value: string) {
    Object.freeze(this);
  }

  /** Mints a new one. The generator's output is validated like any other input. */
  public static create(generator: IdGenerator): TerminalId {
    return TerminalId.fromString(generator.newUuid());
  }

  /** Throws `ValidationError` when `raw` is not shaped like a UUID. */
  public static fromString(raw: string): TerminalId {
    return new TerminalId(parseUuid(raw, 'terminalId'));
  }

  public equals(other: TerminalId): boolean {
    return this.value === other.value;
  }

  public toString(): string {
    return this.value;
  }
}
