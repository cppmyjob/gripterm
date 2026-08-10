import { ValidationError } from '../errors/gripterm-error.js';

/**
 * What a session has cost so far.
 *
 * Its only source is the statusline forwarder: hooks do not carry cost at all.
 * That is why the snapshot is nullable everywhere it appears -- a terminal
 * whose statusline has not fired yet has no cost, which is different from a
 * cost of zero.
 */
export class CostSnapshot {
  public readonly totalUsd: number;
  public readonly durationMs: number;

  private constructor(totalUsd: number, durationMs: number) {
    this.totalUsd = totalUsd;
    this.durationMs = durationMs;
    Object.freeze(this);
  }

  public static create(totalUsd: number, durationMs: number): CostSnapshot {
    if (!Number.isFinite(totalUsd) || totalUsd < 0) {
      throw new ValidationError('totalUsd must be a finite, non-negative number', {
        details: { totalUsd },
      });
    }
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new ValidationError('durationMs must be a finite, non-negative number', {
        details: { durationMs },
      });
    }
    return new CostSnapshot(totalUsd, durationMs);
  }

  public equals(other: CostSnapshot): boolean {
    return this.totalUsd === other.totalUsd && this.durationMs === other.durationMs;
  }
}
