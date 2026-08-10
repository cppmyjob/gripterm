import { ValidationError } from '../errors/gripterm-error.js';

/**
 * How full the model's context window is, as a percentage.
 *
 * No upper bound is enforced. The CLI's `context_window.used_percentage` is
 * reported, not contracted, and it also publishes an `exceeds_200k_tokens`
 * flag -- so a value above one hundred is a thing that can be said. Rejecting a
 * number we merely did not expect would turn a display detail into a thrown
 * error on the ingest path, which is a far worse failure than a bar drawn too
 * long.
 */
export class ContextWindowSnapshot {
  public readonly usedPercentage: number;

  private constructor(usedPercentage: number) {
    this.usedPercentage = usedPercentage;
    Object.freeze(this);
  }

  public static create(usedPercentage: number): ContextWindowSnapshot {
    if (!Number.isFinite(usedPercentage) || usedPercentage < 0) {
      throw new ValidationError('usedPercentage must be a finite, non-negative number', {
        details: { usedPercentage },
      });
    }
    return new ContextWindowSnapshot(usedPercentage);
  }

  public equals(other: ContextWindowSnapshot): boolean {
    return this.usedPercentage === other.usedPercentage;
  }
}
