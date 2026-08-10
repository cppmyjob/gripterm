import { ValidationError } from '../errors/gripterm-error';

/**
 * A line the human wrote about a terminal. Claude Code never touches it and
 * nothing can rebuild it, which is the whole reason human metadata is stored
 * separately from observed state.
 */
export class Note {
  private readonly _atMs: number;

  private constructor(atMs: number, public readonly text: string) {
    this._atMs = atMs;
    Object.freeze(this);
  }

  public get at(): Date {
    return new Date(this._atMs);
  }

  /**
   * A copy is taken, and `at` above hands out another. A `Date` is mutable
   * through `setTime` no matter how many `readonly` keywords surround it, so
   * without copying at both ends the immutability of this class would be a
   * claim the language does not support.
   */
  public static create(at: Date, text: string): Note {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new ValidationError('a note must have text', { details: { text } });
    }
    if (Number.isNaN(at.getTime())) {
      throw new ValidationError('a note must have a valid timestamp');
    }
    return new Note(at.getTime(), trimmed);
  }

  public equals(other: Note): boolean {
    return this._atMs === other._atMs && this.text === other.text;
  }
}
