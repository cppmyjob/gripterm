import { ValidationError } from '../errors/gripterm-error.js';

/**
 * Identifies an ACTIVATION, not a window in general: the same window reopened
 * on the same folder comes back with a new `OwnerId`. That is why ownership has
 * to be transferable at all -- without an explicit hand-over a restarted editor
 * could not write its own records.
 *
 * Not a UUID: the value is whatever the host offers as a stable per-activation
 * string, and constraining its shape would buy nothing an equality test does
 * not already give.
 */
export class OwnerId {
  /** Nominal marker -- see the note on `TerminalId._nominal`. */
  private declare readonly _nominal: 'OwnerId';

  private constructor(public readonly value: string) {
    Object.freeze(this);
  }

  /** Throws `ValidationError` on an empty or blank string. */
  public static fromString(raw: string): OwnerId {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new ValidationError('ownerId must not be blank', { details: { raw } });
    }
    return new OwnerId(trimmed);
  }

  public equals(other: OwnerId): boolean {
    return this.value === other.value;
  }

  public toString(): string {
    return this.value;
  }
}
