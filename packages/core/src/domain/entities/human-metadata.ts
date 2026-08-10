import { ValidationError } from '../errors/gripterm-error';
import type { Note } from './note';

export interface HumanMetadataParams {
  readonly displayName: string;
  readonly task: string | null;
  readonly notes: readonly Note[];
  readonly tags: readonly string[];
  /** A theme colour id, e.g. `terminal.ansiCyan`. `null` leaves the host's default. */
  readonly color: string | null;
}

/**
 * Everything about a terminal that a person put there. Claude Code never writes
 * any of it, and nothing can reconstruct it from events -- which is exactly why
 * it lives apart from `ObservedState`, whose loss costs nothing.
 */
export class HumanMetadata {
  public readonly displayName: string;
  public readonly task: string | null;
  public readonly notes: readonly Note[];
  public readonly tags: readonly string[];
  public readonly color: string | null;

  private constructor(params: HumanMetadataParams) {
    this.displayName = params.displayName;
    this.task = params.task;
    // Copied, then frozen. `readonly string[]` is a promise to the compiler
    // only: the caller keeps a reference to the array it passed in and could
    // push to it afterwards, and `entry.metadata.tags.push(...)` would
    // otherwise be a silent mutation of a "frozen" object.
    this.notes = Object.freeze([...params.notes]);
    this.tags = Object.freeze([...params.tags]);
    this.color = params.color;
    Object.freeze(this);
  }

  public static create(params: HumanMetadataParams): HumanMetadata {
    const displayName = params.displayName.trim();
    if (displayName.length === 0) {
      throw new ValidationError('displayName must not be blank', {
        details: { displayName: params.displayName },
      });
    }

    const tags: string[] = [];
    for (const tag of params.tags) {
      const trimmed = tag.trim();
      if (trimmed.length === 0) {
        throw new ValidationError('a tag must not be blank', { details: { tags: params.tags } });
      }
      // A repeated tag says nothing twice; keeping it would make two equal
      // metadata objects compare unequal on the order of insertion alone.
      if (!tags.includes(trimmed)) {
        tags.push(trimmed);
      }
    }

    return new HumanMetadata({ ...params, displayName, tags });
  }

  public equals(other: HumanMetadata): boolean {
    return (
      this.displayName === other.displayName &&
      this.task === other.task &&
      this.color === other.color &&
      this.tags.length === other.tags.length &&
      this.tags.every((tag, index) => tag === other.tags[index]) &&
      this.notes.length === other.notes.length &&
      this.notes.every((note, index) => {
        const counterpart = other.notes[index];
        return counterpart !== undefined && note.equals(counterpart);
      })
    );
  }
}
